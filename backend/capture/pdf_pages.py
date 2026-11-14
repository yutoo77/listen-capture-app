"""CAS-protected page selections reuse one private source and durable receipt."""

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .models import PdfImport, PdfPageRequest
from .services import Conflict

MAX_SELECTIONS = 20


@transaction.atomic
def select_pages(owner, job_id, values):
    get_user_model().objects.select_for_update().get(pk=owner.pk)
    receipt = (
        PdfPageRequest.objects.filter(owner=owner, client_id=values["client_id"])
        .select_related("job")
        .first()
    )
    if receipt:
        if (
            receipt.job_id != job_id
            or receipt.start_page != values["start_page"]
            or receipt.end_page != values["end_page"]
            or receipt.base_revision != values["revision"]
        ):
            raise Conflict("この送信番号は別のページ選択に使われています。")
        # A later selection may already exist. Replay never writes the old
        # revision back or schedules another extraction.
        return receipt.job, False
    job = get_object_or_404(
        PdfImport.objects.select_for_update(), pk=job_id, owner=owner
    )
    if job.confirmed_document_snapshot:
        raise Conflict(
            "本文は登録済みです。ページを変える場合は新しく取り込んでください。"
        )
    if job.deleted_at or not job.storage_key or job.expires_at <= timezone.now():
        raise Conflict("原本が削除または期限切れです。PDFを選び直してください。")
    if values["revision"] != job.selection_revision:
        raise Conflict(
            "別の画面でページが変更されています。最新の取込状況を確認してください。"
        )
    if not job.page_count:
        raise Conflict("原本のページ数を確認しています。抽出状況を確認してください。")
    first, last = values["start_page"], values["end_page"]
    if not 1 <= first <= last <= job.page_count or last - first + 1 > 50:
        raise ValidationError(
            {"pages": "原本の範囲内で連続する50ページ以内を選んでください。"}
        )
    if PdfPageRequest.objects.filter(job=job).count() >= MAX_SELECTIONS:
        raise Conflict(
            "この原本のページ選択回数が上限です。必要な範囲を新しく取り込んでください。"
        )
    unchanged = (job.start_page, job.end_page) == (first, last) and job.state in {
        "queued",
        "running",
        "succeeded",
    }
    if not unchanged:
        job.start_page, job.end_page = first, last
        job.selection_revision += 1
        job.state, job.error_code = "queued", None
        job.extracted_text = ""
        job.lease_token = job.lease_expires_at = None
        job.save()
    PdfPageRequest.objects.create(
        owner=owner,
        client_id=values["client_id"],
        job=job,
        start_page=first,
        end_page=last,
        base_revision=values["revision"],
        selected_revision=job.selection_revision,
    )
    return job, not unchanged
