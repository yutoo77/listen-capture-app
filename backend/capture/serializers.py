from collections.abc import Mapping

from rest_framework import serializers

from .models import (
    AudioVersion,
    Document,
    DocumentVersion,
    GenerationJob,
    TextBlock,
    VoiceMemo,
)


class StrictInputSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, Mapping):
            return super().to_internal_value(data)
        unexpected = set(data) - set(self.fields)
        if unexpected:
            raise serializers.ValidationError(
                {key: "この項目は指定できません。" for key in unexpected}
            )
        return super().to_internal_value(data)


class DocumentInput(StrictInputSerializer):
    title = serializers.CharField(max_length=160, trim_whitespace=True)
    text = serializers.CharField(max_length=20000, trim_whitespace=False)

    def validate_text(self, value):
        if not value.strip() or "\x00" in value:
            raise serializers.ValidationError(
                "空白だけの本文やNUL文字は保存できません。"
            )
        return value


class DocumentPatchInput(DocumentInput):
    expected_version = serializers.UUIDField(required=False)
    expected_updated_at = serializers.DateTimeField(required=False)


class MemoInput(StrictInputSerializer):
    client_id = serializers.UUIDField()
    audio_version = serializers.UUIDField()
    position_ms = serializers.IntegerField(min_value=0, max_value=24 * 60 * 60 * 1000)
    duration_ms = serializers.IntegerField(min_value=1, max_value=60000)
    text = serializers.CharField(
        max_length=10000,
        required=False,
        allow_blank=True,
        default="",
        trim_whitespace=False,
    )
    audio = serializers.FileField()

    def validate_text(self, value):
        if "\x00" in value:
            raise serializers.ValidationError("NUL文字は保存できません。")
        return value


class PlaybackProgressInput(StrictInputSerializer):
    position_ms = serializers.IntegerField(min_value=0, max_value=2147483647)
    revision = serializers.IntegerField(min_value=0, max_value=9007199254740990)
    client_id = serializers.UUIDField()


class MemoTextInput(StrictInputSerializer):
    text = serializers.CharField(
        max_length=10000, allow_blank=True, trim_whitespace=False
    )

    def validate_text(self, value):
        if "\x00" in value:
            raise serializers.ValidationError("NUL文字は保存できません。")
        return value


class AudioSerializer(serializers.ModelSerializer):
    status = serializers.SerializerMethodField()
    media_url = serializers.SerializerMethodField()
    playlist_url = serializers.SerializerMethodField()

    class Meta:
        model = AudioVersion
        fields = [
            "id",
            "document_version",
            "kind",
            "delivery",
            "status",
            "duration_ms",
            "media_url",
            "playlist_url",
            "synthesis_profile",
            "created_at",
        ]

    def get_status(self, obj):
        return "ready"

    def get_media_url(self, obj):
        return f"/api/audio/{obj.id}/content/" if obj.delivery == "single" else None

    def get_playlist_url(self, obj):
        return f"/api/audio/{obj.id}/playlist/"


class TextBlockSerializer(serializers.ModelSerializer):
    class Meta:
        model = TextBlock
        fields = ["id", "index", "start_offset", "end_offset", "text"]


class DocumentVersionContextSerializer(serializers.ModelSerializer):
    blocks = TextBlockSerializer(source="text_blocks", many=True, read_only=True)

    class Meta:
        model = DocumentVersion
        fields = ["id", "document", "number", "text", "blocks", "created_at"]
        read_only_fields = fields


class GenerationInput(StrictInputSerializer):
    document_version = serializers.UUIDField()
    client_id = serializers.UUIDField()


class GenerationSerializer(serializers.ModelSerializer):
    document_version = serializers.UUIDField(source="version_id_snapshot")

    class Meta:
        model = GenerationJob
        fields = [
            "id",
            "client_id",
            "document_version",
            "state",
            "audio_version",
            "error_code",
            "created_at",
            "updated_at",
        ]


class DocumentListSerializer(serializers.ListSerializer):
    def to_representation(self, data):
        documents = list(data.all() if hasattr(data, "all") else data)
        versions = {}
        for document in documents:
            version = next(iter(document.versions.all()), None)
            document._current_generation = None
            if version:
                versions[version.id] = document
        # One bounded query for all current jobs, never one query per document.
        for job in (
            GenerationJob.objects.filter(document_version_id__in=versions)
            .order_by("document_version_id", "-created_at")
            .distinct("document_version_id")
        ):
            versions[job.document_version_id]._current_generation = job
        return super().to_representation(documents)


class DocumentSerializer(serializers.ModelSerializer):
    current_version = serializers.SerializerMethodField()
    audio_versions = serializers.SerializerMethodField()
    audio_generation = serializers.SerializerMethodField()
    source_pdf = serializers.SerializerMethodField()

    class Meta:
        model = Document
        list_serializer_class = DocumentListSerializer
        fields = [
            "id",
            "title",
            "created_at",
            "updated_at",
            "current_version",
            "audio_versions",
            "audio_generation",
            "source_pdf",
        ]

    def get_current_version(self, obj):
        version = next(iter(obj.versions.all()), None)
        if version is None:
            return None
        text = (
            obj.current_version_text
            if hasattr(obj, "current_version_text")
            else version.text
        )
        return {"id": str(version.id), "number": version.number, "text": text}

    def get_audio_versions(self, obj):
        audios = [
            audio
            for version in obj.versions.all()
            for audio in version.audio_versions.all()
        ]
        audios.sort(
            key=lambda item: (item.document_version.number, item.created_at),
            reverse=True,
        )
        return AudioSerializer(audios, many=True).data

    def get_audio_generation(self, obj):
        if hasattr(obj, "_current_generation"):
            job = obj._current_generation
        else:
            version = next(iter(obj.versions.all()), None)
            job = (
                GenerationJob.objects.filter(document_version=version).first()
                if version
                else None
            )
        return GenerationSerializer(job).data if job else None

    def get_source_pdf(self, obj):
        source = next(iter(obj.pdf_imports.all()), None)
        if source is None:
            return None
        return {
            "id": str(source.id),
            "source_available": bool(source.storage_key),
            "source_url": f"/api/pdf-imports/{source.id}/source/"
            if source.storage_key
            else None,
            "source_size_bytes": source.source_size_bytes,
            "page_count": source.page_count,
            "start_page": source.start_page,
            "end_page": source.end_page,
            "selection_revision": source.selection_revision,
        }


class MemoSerializer(serializers.ModelSerializer):
    client_id = serializers.UUIDField(source="submission.client_id")
    document = serializers.SerializerMethodField()
    document_version = serializers.SerializerMethodField()
    media_url = serializers.SerializerMethodField()

    class Meta:
        model = VoiceMemo
        fields = [
            "id",
            "client_id",
            "audio_version",
            "document",
            "document_version",
            "position_ms",
            "duration_ms",
            "text",
            "media_url",
            "created_at",
        ]

    def get_document(self, obj):
        document = obj.audio_version.document_version.document
        return {"id": str(document.id), "title": document.title}

    def get_document_version(self, obj):
        version = obj.audio_version.document_version
        return {"id": str(version.id), "number": version.number}

    def get_media_url(self, obj):
        return f"/api/memos/{obj.id}/content/"
