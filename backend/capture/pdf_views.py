from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.parsers import MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from . import pdf_imports, pdf_pages, storage
from .models import PdfImport
from .serializers import DocumentInput, DocumentSerializer, StrictInputSerializer
from .views import check_workspace_user, documents_for


class UploadInput(StrictInputSerializer):
    client_id = serializers.UUIDField()
    file = serializers.FileField()


class ConfirmInput(DocumentInput):
    client_id = serializers.UUIDField()
    selection_revision = serializers.IntegerField(required=False, min_value=0)


class PagesInput(StrictInputSerializer):
    client_id = serializers.UUIDField()
    start_page = serializers.IntegerField(min_value=1, max_value=200)
    end_page = serializers.IntegerField(min_value=1, max_value=200)
    revision = serializers.IntegerField(min_value=0, max_value=2147483646)


class PdfImportSerializer(serializers.ModelSerializer):
    source_available = serializers.SerializerMethodField()
    source_url = serializers.SerializerMethodField()

    class Meta:
        model = PdfImport
        fields = [
            "id",
            "client_id",
            "state",
            "error_code",
            "suggested_title",
            "extracted_text",
            "page_count",
            "start_page",
            "end_page",
            "selection_revision",
            "source_size_bytes",
            "source_available",
            "source_url",
            "confirmed_document",
            "created_at",
            "expires_at",
        ]

    def get_source_available(self, obj):
        return bool(obj.storage_key)

    def get_source_url(self, obj):
        return f"/api/pdf-imports/{obj.pk}/source/" if obj.storage_key else None


class UploadThrottle(UserRateThrottle):
    # Keep upload admission separate from normal read/poll traffic. Sharing the
    # default `user` cache key makes 30 harmless GETs exhaust this smaller limit.
    scope = "pdf_upload"
    rate = "30/hour"


class PdfImportListView(APIView):
    parser_classes = [MultiPartParser]

    def get(self, request):
        check_workspace_user(request)
        jobs = PdfImport.objects.filter(
            owner=request.user,
            deleted_at__isnull=True,
            confirmed_document_snapshot__isnull=True,
        )[: pdf_imports.MAX_IMPORTS]
        return Response(PdfImportSerializer(jobs, many=True).data)

    def get_throttles(self):
        return (
            [UploadThrottle()]
            if self.request.method == "POST"
            else super().get_throttles()
        )

    def post(self, request):
        check_workspace_user(request)
        values = UploadInput(data=request.data)
        values.is_valid(raise_exception=True)
        job, created = pdf_imports.enqueue(
            request.user,
            values.validated_data["file"],
            values.validated_data["client_id"],
        )
        return Response(PdfImportSerializer(job).data, status=202 if created else 200)


class PdfImportDetailView(APIView):
    def get(self, request, job_id):
        job = get_object_or_404(PdfImport, pk=job_id, owner=request.user)
        return Response(PdfImportSerializer(job).data)

    def delete(self, request, job_id):
        pdf_imports.remove(request.user, job_id)
        return Response(status=204)


class PdfImportConfirmView(APIView):
    def post(self, request, job_id):
        values = ConfirmInput(data=request.data)
        values.is_valid(raise_exception=True)
        document, created = pdf_imports.confirm(
            request.user, job_id, values.validated_data
        )
        return Response(
            DocumentSerializer(
                get_object_or_404(documents_for(request.user), pk=document.pk)
            ).data,
            status=201 if created else 200,
        )


class PdfImportPagesView(APIView):
    throttle_classes = [UploadThrottle]

    def post(self, request, job_id):
        values = PagesInput(data=request.data)
        values.is_valid(raise_exception=True)
        job, created = pdf_pages.select_pages(
            request.user, job_id, values.validated_data
        )
        return Response(PdfImportSerializer(job).data, status=202 if created else 200)


class PdfImportSourceView(APIView):
    def get(self, request, job_id):
        job = get_object_or_404(
            PdfImport,
            pk=job_id,
            owner=request.user,
            storage_key__isnull=False,
            deleted_at__isnull=True,
        )
        try:
            metadata = storage.stat(job.storage_key)
            if metadata.size_bytes != job.source_size_bytes:
                raise storage.StorageUnavailable()
            source = storage.open_read(job.storage_key)
        except FileNotFoundError as error:
            raise Http404() from error
        except OSError:
            return Response(
                {
                    "detail": "元PDFを取得できません。しばらくしてから再試行してください。"
                },
                status=503,
                headers={"Retry-After": "30"},
            )
        response = FileResponse(
            source,
            content_type="application/pdf",
            as_attachment=True,
            filename="source.pdf",
        )
        response["X-Content-Type-Options"] = "nosniff"
        response["Content-Security-Policy"] = "sandbox; default-src 'none'"
        response["Cache-Control"] = "private, no-store"
        response["Content-Length"] = str(metadata.size_bytes)
        return response
