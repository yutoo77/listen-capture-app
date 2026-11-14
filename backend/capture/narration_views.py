from django.shortcuts import get_object_or_404
from django.http import JsonResponse
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from . import narration, narration_provider
from .models import AudioVersion, Document
from .narration_models import NarrationJob
from .serializers import StrictInputSerializer
from .views import check_workspace_user


class StartInput(StrictInputSerializer):
    document_version = serializers.UUIDField()
    client_id = serializers.UUIDField()
    provider = serializers.ChoiceField(
        choices=["polly", "windows", "fixture", "voicevox"]
    )
    voice = serializers.JSONField(required=False)


class RetryInput(StrictInputSerializer):
    client_id = serializers.UUIDField()
    acknowledge_unknown = serializers.BooleanField(default=False)


class CancelInput(StrictInputSerializer):
    pass


def representation(job):
    segments = list(job.segments.all())
    return {
        "id": str(job.id),
        "document_version": str(job.version_id_snapshot),
        "provider": job.provider,
        "voice": job.voice_settings or None,
        "synthesis_profile": job.synthesis_profile,
        "state": job.state,
        "audio_version": str(job.audio_version_id) if job.audio_version_id else None,
        "error_code": job.error_code,
        "cancel_requested_at": (
            job.cancel_requested_at.isoformat() if job.cancel_requested_at else None
        ),
        "character_count": job.character_count,
        "completed_segments": sum(segment.state == "succeeded" for segment in segments),
        "total_segments": len(segments),
        "retry_characters": sum(
            segment.end_offset - segment.start_offset
            for segment in segments
            if segment.state != "succeeded"
        ),
        "has_unknown": any(segment.state == "unknown" for segment in segments),
        "segments": [
            {
                "index": segment.index,
                "start_offset": segment.start_offset,
                "end_offset": segment.end_offset,
                "state": segment.state,
                "error_code": segment.error_code,
                "duration_ms": segment.duration_ms,
            }
            for segment in segments
        ],
        "created_at": job.created_at.isoformat(),
        "updated_at": job.updated_at.isoformat(),
    }


class ConfigView(APIView):
    def get(self, request):
        return Response(narration_provider.configuration())


class StartView(APIView):
    def get(self, request, document_id):
        document = get_object_or_404(Document, id=document_id, owner=request.user)
        narration.expire_leases(owner=request.user)
        job = NarrationJob.objects.filter(
            owner=request.user, document_version=document.versions.first()
        ).first()
        # DRF renders Response(None) as an empty body, which fetch.json rejects.
        return Response(representation(job)) if job else JsonResponse(None, safe=False)

    def post(self, request, document_id):
        values = StartInput(data=request.data)
        values.is_valid(raise_exception=True)
        data = values.validated_data
        job, created = narration.enqueue(
            request.user,
            document_id,
            data["document_version"],
            data["client_id"],
            data["provider"],
            data.get("voice"),
        )
        return Response(representation(job), status=202 if created else 200)


class DetailView(APIView):
    def get(self, request, job_id):
        narration.expire_leases(owner=request.user)
        job = get_object_or_404(NarrationJob, id=job_id, owner=request.user)
        return Response(representation(job))


class RetryView(APIView):
    def post(self, request, job_id):
        values = RetryInput(data=request.data)
        values.is_valid(raise_exception=True)
        data = values.validated_data
        narration.expire_leases(owner=request.user)
        job, created = narration.retry(
            request.user, job_id, data["client_id"], data["acknowledge_unknown"]
        )
        return Response(representation(job), status=202 if created else 200)


class CancelView(APIView):
    def post(self, request, job_id):
        check_workspace_user(request)
        values = CancelInput(data=request.data)
        values.is_valid(raise_exception=True)
        return Response(representation(narration.cancel(request.user, job_id)))


class MappingView(APIView):
    def get(self, request, audio_id):
        audio = get_object_or_404(
            AudioVersion, id=audio_id, document_version__document__owner=request.user
        )
        if audio.delivery == "playlist":
            from .playlist import manifest

            data = manifest(audio)
            return Response(
                {
                    "audio_version": data["audio_version"],
                    "document_version": data["document_version"],
                    "precision": data["precision"],
                    "segments": [
                        {
                            key: segment[key]
                            for key in (
                                "index",
                                "start_offset",
                                "end_offset",
                                "start_ms",
                                "end_ms",
                                "block_ids",
                            )
                        }
                        for segment in data["segments"]
                    ],
                }
            )
        job = NarrationJob.objects.filter(
            audio_version=audio, state="succeeded", owner=request.user
        ).first()
        blocks = list(audio.document_version.text_blocks.all())
        return Response(
            {
                "audio_version": str(audio.id),
                "document_version": str(audio.document_version_id),
                "precision": "segment" if job else "unavailable",
                "segments": [
                    {
                        "index": segment.index,
                        "start_offset": segment.start_offset,
                        "end_offset": segment.end_offset,
                        "start_ms": segment.start_ms,
                        "end_ms": segment.end_ms,
                        "block_ids": [
                            str(block.id)
                            for block in blocks
                            if block.start_offset < segment.end_offset
                            and block.end_offset > segment.start_offset
                        ],
                    }
                    for segment in job.segments.all()
                ]
                if job
                else [],
            }
        )
