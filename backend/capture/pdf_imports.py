"""PDF queue, durable receipts and explicit confirmation of an editable draft."""

from datetime import timedelta
import hashlib
import json
import logging
from pathlib import Path
import uuid

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from . import pdf_sandbox, services, storage
from .models import Document, PdfImport

logger = logging.getLogger("capture.pdf")
MAX_IMPORTS = 20
MAX_SOURCE_BYTES = 50 * 1024 * 1024
LEASE_SECONDS = 60


def enqueue(owner, upload, client_id):
    if upload.size > pdf_sandbox.MAX_BYTES:
        raise ValidationError({"file": "PDFは10 MiB以内にしてください。"})
    data = upload.read(pdf_sandbox.MAX_BYTES + 1)
    if not 0 < len(data) <= pdf_sandbox.MAX_BYTES or not data.startswith(b"%PDF-"):
        raise ValidationError({"file": "有効なPDFファイルを指定してください。"})
    digest = hashlib.sha256(data).hexdigest()
    key = None
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=owner.pk)
            previous = PdfImport.objects.filter(
                owner=owner, client_id=client_id
            ).first()
            if previous:
                if previous.payload_digest != digest:
                    raise services.Conflict("この送信番号は別のPDFに使われています。")
                return previous, False
            retained = PdfImport.objects.filter(owner=owner, storage_key__isnull=False)
            if (
                retained.count() >= MAX_IMPORTS
                or retained.aggregate(total=Sum("source_size_bytes", default=0))[
                    "total"
                ]
                + len(data)
                > MAX_SOURCE_BYTES
            ):
                raise services.Conflict(
                    "PDFの保管上限です。不要な元PDFを削除してください。"
                )
            services.check_quota(owner, added_bytes=len(data))
            key = storage.put_bytes(data, "pdf")
            job = PdfImport.objects.create(
                owner=owner,
                client_id=client_id,
                payload_digest=digest,
                suggested_title=Path(
                    upload.name.replace("\\", "/").replace("\x00", "")
                ).stem[:160]
                or "PDF資料",
                storage_key=key,
                source_size_bytes=len(data),
                expires_at=timezone.now() + timedelta(hours=24),
            )
            return job, True
    except Exception:
        if key:
            storage.delete_key(key)
        raise


def _purge_locked(job, code):
    key = job.storage_key
    job.storage_key = None
    job.source_size_bytes = 0
    job.extracted_text = ""
    job.lease_token = job.lease_expires_at = None
    job.deleted_at = timezone.now()
    job.state, job.error_code = "failed", code
    job.save()
    if key:
        transaction.on_commit(lambda: storage.delete_key(key))


@transaction.atomic
def remove(owner, job_id):
    job = get_object_or_404(
        PdfImport.objects.select_for_update(), pk=job_id, owner=owner
    )
    _purge_locked(job, "source_deleted")


@transaction.atomic
def confirm(owner, job_id, values):
    get_user_model().objects.select_for_update().get(pk=owner.pk)
    job = get_object_or_404(
        PdfImport.objects.select_for_update(), pk=job_id, owner=owner
    )
    revision = values.get("selection_revision", 0)
    if revision != job.selection_revision:
        raise services.Conflict(
            "ページの選択が変わっています。最新の本文を確認してから保存してください。"
        )
    digest = hashlib.sha256(
        json.dumps(
            {"title": values["title"], "text": values["text"]},
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    if job.confirm_digest:
        if job.confirm_digest != digest:
            raise services.Conflict(
                "このPDFは別の内容で登録済みです。保存した資料を開いてください。"
            )
        document = Document.objects.filter(
            pk=job.confirmed_document_snapshot, owner=owner
        ).first()
        if document is None:
            raise services.Conflict(
                "登録した資料は削除されています。再送では復元できません。"
            )
        return document, False
    if job.deleted_at or job.expires_at <= timezone.now():
        raise services.Conflict(
            "この取り込みは削除または期限切れです。PDFを選び直してください。"
        )
    if job.state != "succeeded":
        raise services.Conflict("抽出が完了したPDFだけを資料に登録できます。")
    document = services.create_document(owner, values)
    job.confirmed_document = document
    job.confirmed_document_snapshot = document.pk
    job.confirm_client_id = values["client_id"]
    job.confirm_digest = digest
    # The original now belongs to a confirmed document and no longer expires.
    job.save()
    return document, True


def expire_jobs():
    now = timezone.now()
    PdfImport.objects.filter(state="running", lease_expires_at__lte=now).update(
        state="failed",
        error_code="processing_timeout",
        lease_token=None,
        lease_expires_at=None,
        updated_at=now,
    )
    candidates = list(
        PdfImport.objects.filter(
            confirmed_document_snapshot__isnull=True,
            storage_key__isnull=False,
            expires_at__lte=now,
        ).values_list("id", flat=True)[:100]
    )
    count = 0
    for job_id in candidates:
        with transaction.atomic():
            job = (
                PdfImport.objects.select_for_update()
                .filter(
                    pk=job_id,
                    confirmed_document_snapshot__isnull=True,
                    storage_key__isnull=False,
                    expires_at__lte=now,
                )
                .first()
            )
            if job:
                _purge_locked(job, "expired")
                count += 1
    return count


def claim_job():
    expire_jobs()
    with transaction.atomic():
        job = (
            PdfImport.objects.select_for_update(skip_locked=True)
            .filter(
                state="queued",
                deleted_at__isnull=True,
                storage_key__isnull=False,
                expires_at__gt=timezone.now(),
            )
            .order_by("created_at")
            .first()
        )
        if not job:
            return None
        job.state = "running"
        job.lease_token = uuid.uuid4()
        job.lease_expires_at = timezone.now() + timedelta(seconds=LEASE_SECONDS)
        job.save()
        return job


def process_job(job):
    token = job.lease_token
    try:
        if not PdfImport.objects.filter(
            pk=job.pk,
            state="running",
            lease_token=token,
            lease_expires_at__gt=timezone.now(),
            deleted_at__isnull=True,
        ).exists():
            return
        result = pdf_sandbox.extract(
            storage.read_bytes(job.storage_key, max_bytes=pdf_sandbox.MAX_BYTES),
            start_page=job.start_page,
            end_page=job.end_page,
        )
        with transaction.atomic():
            current = (
                PdfImport.objects.select_for_update()
                .filter(
                    pk=job.pk,
                    state="running",
                    lease_token=token,
                    lease_expires_at__gt=timezone.now(),
                    deleted_at__isnull=True,
                    expires_at__gt=timezone.now(),
                )
                .first()
            )
            if not current:
                return
            current.extracted_text = result["text"]
            current.page_count = result["page_count"]
            current.start_page, current.end_page = (
                result["start_page"],
                result["end_page"],
            )
            current.state = "succeeded"
            current.error_code = None
            current.lease_token = current.lease_expires_at = None
            current.save()
        logger.info(
            "pdf_extraction_succeeded job=%s pages=%d", job.pk, result["page_count"]
        )
    except Exception as error:
        code = (
            error.code
            if isinstance(error, pdf_sandbox.PdfFailure)
            else "storage_unavailable"
            if isinstance(error, OSError)
            else "internal_error"
        )
        metadata = {}
        if isinstance(error, pdf_sandbox.PdfFailure) and error.page_count is not None:
            metadata["page_count"] = error.page_count
        PdfImport.objects.filter(pk=job.pk, state="running", lease_token=token).update(
            state="failed",
            error_code=code,
            lease_token=None,
            lease_expires_at=None,
            updated_at=timezone.now(),
            **metadata,
        )
        logger.warning("pdf_extraction_failed job=%s code=%s", job.pk, code)


def work_once():
    job = claim_job()
    if job:
        process_job(job)
        return True
    return False
