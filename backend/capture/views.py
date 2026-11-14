import re
import uuid

from django.conf import settings
from django.db import connection, transaction
from django.db.models import OuterRef, Prefetch, Subquery
from django.http import Http404, HttpResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from . import generation, progress, services, storage
from .models import AudioVersion, Document, DocumentVersion, GenerationJob, VoiceMemo
from .serializers import (
    DocumentInput,
    DocumentPatchInput,
    DocumentSerializer,
    DocumentVersionContextSerializer,
    GenerationInput,
    GenerationSerializer,
    MemoInput,
    MemoSerializer,
    MemoTextInput,
    PlaybackProgressInput,
)


def check_workspace_user(request):
    workspace_user = request.headers.get("X-Workspace-User")
    if workspace_user is not None and workspace_user != str(request.user.pk):
        raise services.Conflict(
            {
                "code": "workspace_changed",
                "detail": "ログイン中のアカウントが変わりました。元のアカウントでログインし直してください。",
            }
        )


def documents_for(user):
    latest_text = (
        DocumentVersion.objects.filter(document_id=OuterRef("pk"))
        .order_by("-number")
        .values("text")[:1]
    )
    return (
        Document.objects.filter(owner=user)
        .annotate(current_version_text=Subquery(latest_text))
        .prefetch_related(
            "pdf_imports",
            Prefetch(
                "versions",
                queryset=DocumentVersion.objects.defer("text").prefetch_related(
                    "audio_versions"
                ),
            ),
        )
    )


def memos_for(user):
    return (
        VoiceMemo.objects.filter(audio_version__document_version__document__owner=user)
        .select_related("audio_version__document_version__document", "submission")
        .defer("audio_version__document_version__text")
    )


class HealthView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        except Exception:
            return Response({"status": "unavailable"}, status=503)
        return Response({"status": "ok"})


class DocumentListView(APIView):
    def get(self, request):
        check_workspace_user(request)
        return Response(
            DocumentSerializer(
                documents_for(request.user)[: settings.MAX_DOCUMENTS_PER_USER],
                many=True,
            ).data
        )

    def post(self, request):
        check_workspace_user(request)
        serializer = DocumentInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        document = services.create_document(request.user, serializer.validated_data)
        document = documents_for(request.user).get(pk=document.pk)
        return Response(
            DocumentSerializer(document).data, status=status.HTTP_201_CREATED
        )


class DocumentDetailView(APIView):
    def get(self, request, document_id):
        document = get_object_or_404(documents_for(request.user), id=document_id)
        return Response(DocumentSerializer(document).data)

    def patch(self, request, document_id):
        get_object_or_404(documents_for(request.user), id=document_id)
        serializer = DocumentPatchInput(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        document = services.update_document(
            request.user, document_id, serializer.validated_data
        )
        document = documents_for(request.user).get(pk=document.pk)
        return Response(DocumentSerializer(document).data)

    def delete(self, request, document_id):
        with transaction.atomic():
            document = get_object_or_404(
                Document.objects.select_for_update(), id=document_id, owner=request.user
            )
            document.delete()
        return Response(status=204)


class DocumentVersionDetailView(APIView):
    def get(self, request, document_id, version_id):
        # Both parent and version are required, so guessing either UUID cannot
        # reveal another account's text or a version from another document.
        version = get_object_or_404(
            DocumentVersion,
            id=version_id,
            document_id=document_id,
            document__owner=request.user,
        )
        return Response(DocumentVersionContextSerializer(version).data)


class DemoView(APIView):
    def post(self, request):
        check_workspace_user(request)
        if request.data:
            raise ValidationError({"detail": "デモ作成では追加項目を指定できません。"})
        document, created = services.create_demo(request.user)
        document = documents_for(request.user).get(pk=document.pk)
        return Response(
            DocumentSerializer(document).data, status=201 if created else 200
        )


class DocumentGenerationView(APIView):
    def post(self, request, document_id):
        serializer = GenerationInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        job, created = generation.enqueue(
            request.user, document_id, values["document_version"], values["client_id"]
        )
        return Response(GenerationSerializer(job).data, status=202 if created else 200)


class GenerationDetailView(APIView):
    def get(self, request, job_id):
        job = get_object_or_404(GenerationJob, pk=job_id, owner=request.user)
        generation.expire_leases(owner=request.user)
        job.refresh_from_db()
        return Response(GenerationSerializer(job).data)


class MemoUploadThrottle(UserRateThrottle):
    scope = "memo_upload"


class MemoListView(APIView):
    parser_classes = [MultiPartParser, FormParser]

    def get_throttles(self):
        return (
            [MemoUploadThrottle()]
            if self.request.method == "POST"
            else super().get_throttles()
        )

    def get(self, request):
        check_workspace_user(request)
        queryset = memos_for(request.user)
        if request.query_params.get("document"):
            try:
                document_id = uuid.UUID(request.query_params["document"])
            except ValueError as exc:
                raise ValidationError(
                    {"document": "資料IDが正しくありません。"}
                ) from exc
            get_object_or_404(Document, id=document_id, owner=request.user)
            queryset = queryset.filter(
                audio_version__document_version__document_id=document_id
            )
        return Response(
            MemoSerializer(queryset[: settings.MAX_MEMOS_PER_USER], many=True).data
        )

    def post(self, request):
        serializer = MemoInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        memo, created = services.create_memo(request.user, serializer.validated_data)
        return Response(MemoSerializer(memo).data, status=201 if created else 200)


class MemoDetailView(APIView):
    def get(self, request, memo_id):
        return Response(
            MemoSerializer(get_object_or_404(memos_for(request.user), id=memo_id)).data
        )

    def patch(self, request, memo_id):
        memo = get_object_or_404(memos_for(request.user), id=memo_id)
        serializer = MemoTextInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        memo.text = serializer.validated_data["text"]
        memo.save(update_fields=["text"])
        return Response(MemoSerializer(memo).data)

    def delete(self, request, memo_id):
        memo = get_object_or_404(memos_for(request.user), id=memo_id)
        memo.delete()
        return Response(status=204)


def stream_private(request, obj):
    # Every caller resolves obj through its owner-scoped query before any HEAD,
    # GET or remote request. Storage keys are never accepted from the browser.
    try:
        item = storage.stat(obj.storage_key)
    except (storage.StorageMissing, ValueError) as exc:
        raise Http404() from exc
    except OSError:
        return Response(
            {
                "detail": "音声の保存先に接続できません。しばらくして再試行してください。",
                "code": "storage_unavailable",
            },
            status=503,
            headers={"Retry-After": "5"},
        )
    size = item.size_bytes
    suffix = obj.storage_key.rsplit(".", 1)[-1]
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": obj.content_type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Disposition": f'inline; filename="audio.{suffix}"',
    }
    start, length, response_status = 0, size, 200
    requested = request.headers.get("Range")
    if requested:
        match = (
            re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", requested)
            if len(requested) <= 64
            else None
        )
        if not match or not any(match.groups()):
            return HttpResponse(
                status=416, headers={**headers, "Content-Range": f"bytes */{size}"}
            )
        left, right = match.groups()
        if left:
            start = int(left)
            end = min(int(right), size - 1) if right else size - 1
        else:
            count = int(right)
            start, end = max(0, size - count), size - 1
            if count <= 0:
                start = size
        if start >= size or end < start:
            return HttpResponse(
                status=416, headers={**headers, "Content-Range": f"bytes */{size}"}
            )
        length, response_status = end - start + 1, 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(length)
    if request.method == "HEAD":
        return HttpResponse(status=response_status, headers=headers)
    try:
        source = storage.open_read(
            obj.storage_key, start=start, length=length, etag=item.etag
        )
    except storage.StorageMissing as exc:
        raise Http404() from exc
    except OSError:
        return Response(
            {
                "detail": "音声の保存先に接続できません。しばらくして再試行してください。",
                "code": "storage_unavailable",
            },
            status=503,
            headers={"Retry-After": "5"},
        )

    def chunks():
        try:
            while chunk := source.read(65536):
                yield chunk
        finally:
            source.close()

    response = StreamingHttpResponse(chunks(), status=response_status, headers=headers)
    # A disconnect may close a response before its generator is first advanced;
    # generator.close() alone would not enter that generator's finally block.
    response._resource_closers.append(source.close)
    return response


class AudioContentView(APIView):
    def get(self, request, audio_id):
        audio = get_object_or_404(
            AudioVersion, id=audio_id, document_version__document__owner=request.user
        )
        if audio.delivery != "single":
            raise Http404()
        return stream_private(request, audio)

    head = get


class PlaybackProgressView(APIView):
    def get(self, request, audio_id):
        return Response(progress.read(request.user, audio_id))

    def put(self, request, audio_id):
        serializer = PlaybackProgressInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            result = progress.update(request.user, audio_id, serializer.validated_data)
        except progress.ProgressConflict as exc:
            return Response(
                {
                    "code": "progress_conflict",
                    "detail": "別の画面で再生位置が更新されました。保存済みの位置を確認してください。",
                    "progress": exc.progress,
                },
                status=409,
            )
        return Response(result)


class MemoContentView(APIView):
    def get(self, request, memo_id):
        memo = get_object_or_404(memos_for(request.user), id=memo_id)
        return stream_private(request, memo)

    head = get
