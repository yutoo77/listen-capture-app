import hashlib
import json
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Case, IntegerField, Sum, Value, When
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import APIException, ValidationError

from . import storage
from .audio import probe_duration, validate_upload
from .models import (
    AudioVersion,
    Document,
    DocumentVersion,
    MemoSubmission,
    NarrationSegment,
    PdfImport,
    TextBlock,
    TtsCapacityReservation,
    VoiceMemo,
)


class Conflict(APIException):
    status_code = 409
    default_detail = (
        "この録音の送信番号は既に使われています。保存済みメモを確認してください。"
    )


class DocumentVersionConflict(Conflict):
    def __init__(self, current_version):
        super().__init__(
            {
                "code": "version_conflict",
                "detail": "資料が更新されています。最新版を確認してから保存してください。",
                "current_version": str(current_version),
            }
        )


def check_quota(owner, *, added_bytes=0, new_document=False, new_memo=False):
    """Call only while holding the owner's row lock inside a transaction."""
    if (
        new_document
        and Document.objects.filter(owner=owner).count()
        >= settings.MAX_DOCUMENTS_PER_USER
    ):
        raise Conflict("資料数の上限です。不要な資料を削除してから再試行してください。")
    memos = VoiceMemo.objects.filter(
        audio_version__document_version__document__owner=owner
    )
    if new_memo and memos.count() >= settings.MAX_MEMOS_PER_USER:
        raise Conflict(
            "録音メモ数の上限です。不要なメモを削除してから再試行してください。"
        )
    audios = AudioVersion.objects.filter(document_version__document__owner=owner)
    # Unknown legacy sizes reserve 12 MiB until explicit reconciliation; no undercount.
    accounted = Case(
        When(size_bytes=0, then=Value(12 * 1024 * 1024)),
        default="size_bytes",
        output_field=IntegerField(),
    )
    used = sum(
        queryset.aggregate(total=Sum(accounted, default=0))["total"]
        for queryset in [memos, audios]
    )
    used += PdfImport.objects.filter(owner=owner).aggregate(
        total=Sum("source_size_bytes", default=0)
    )["total"]
    used += NarrationSegment.objects.filter(job__owner=owner).aggregate(
        total=Sum("size_bytes", default=0)
    )["total"]
    used += TtsCapacityReservation.objects.filter(owner=owner).aggregate(
        total=Sum("remaining_bytes", default=0)
    )["total"]
    if used + added_bytes > settings.MAX_PRIVATE_BYTES_PER_USER:
        raise Conflict(
            "保存容量の上限です。不要な録音や資料を削除してから再試行してください。"
        )


@transaction.atomic
def create_document(owner, values):
    get_user_model().objects.select_for_update().get(pk=owner.pk)
    check_quota(owner, new_document=True)
    document = Document.objects.create(owner=owner, title=values["title"])
    version = DocumentVersion.objects.create(
        document=document, number=1, text=values["text"]
    )
    ensure_text_blocks(version)
    return document


@transaction.atomic
def update_document(owner, document_id, values):
    document = get_object_or_404(
        Document.objects.select_for_update(), id=document_id, owner=owner
    )
    values = values.copy()
    expected_version = values.pop("expected_version", None)
    expected_updated_at = values.pop("expected_updated_at", None)
    previous = document.versions.first()
    # Compare inside the same parent-row lock that serializes version creation.
    # A stale retry cannot overwrite a newer body, even if its text now matches.
    if (expected_version is not None and str(expected_version) != str(previous.pk)) or (
        expected_updated_at is not None and expected_updated_at != document.updated_at
    ):
        raise DocumentVersionConflict(previous.pk)
    if "title" in values:
        document.title = values["title"]
    if "text" in values:
        if previous.text != values["text"]:
            if previous.number >= settings.MAX_VERSIONS_PER_DOCUMENT:
                raise Conflict(
                    "この資料の改訂回数が上限です。新しい資料として登録してください。"
                )
            version = DocumentVersion.objects.create(
                document=document, number=previous.number + 1, text=values["text"]
            )
            ensure_text_blocks(version)
    document.save(update_fields=["title", "updated_at"])
    return document


def create_demo(owner):
    data = (Path(settings.BASE_DIR) / "demo" / "sample.mp3").read_bytes()
    text = (Path(settings.BASE_DIR) / "demo" / "sample-script.txt").read_text(
        encoding="utf-8"
    )
    duration = probe_duration(data, "mp3")
    key = None
    try:
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=owner.pk)
            existing = Document.objects.filter(owner=owner, is_demo=True).first()
            if existing:
                return existing, False
            check_quota(owner, new_document=True, added_bytes=len(data))
            document = Document.objects.create(
                owner=owner, title="Listen / Capture — 再生・録音デモ", is_demo=True
            )
            version = DocumentVersion.objects.create(
                document=document, number=1, text=text
            )
            ensure_text_blocks(version)
            key = storage.put_bytes(data, "mp3")
            AudioVersion.objects.create(
                document_version=version,
                kind="demo",
                storage_key=key,
                content_type="audio/mpeg",
                duration_ms=duration,
                size_bytes=len(data),
            )
            return document, True
    except Exception:
        if key:
            storage.delete_key(key)
        raise


def block_spans(text, maximum=1000):
    """Exact Unicode code-point spans, preserving whitespace and source order."""
    start = 0
    while start < len(text):
        end = min(start + maximum, len(text))
        if end < len(text):
            boundary = text.rfind("\n", start + maximum // 2, end)
            if boundary >= start:
                end = boundary + 1
        yield start, end
        start = end


@transaction.atomic
def ensure_text_blocks(version):
    locked = DocumentVersion.objects.select_for_update().get(pk=version.pk)
    existing = list(locked.text_blocks.all())
    if existing:
        return existing
    return TextBlock.objects.bulk_create(
        [
            TextBlock(
                version=locked,
                index=index,
                start_offset=start,
                end_offset=end,
                text=locked.text[start:end],
            )
            for index, (start, end) in enumerate(block_spans(locked.text))
        ]
    )


def create_memo(owner, values):
    # Resolve ownership before expensive parsing. A forged parent receives 404.
    audio = get_object_or_404(
        AudioVersion.objects.select_related("document_version__document"),
        id=values["audio_version"],
        document_version__document__owner=owner,
    )
    if values["position_ms"] > audio.duration_ms:
        raise ValidationError(
            {"position_ms": "再生位置が資料音声の長さを超えています。"}
        )
    data, content_type, suffix = validate_upload(values["audio"])
    canonical = {
        key: str(values[key])
        for key in ["audio_version", "position_ms", "duration_ms", "text"]
    }
    canonical["content_type"] = content_type
    digest = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()
        + b"\x00"
        + data
    ).hexdigest()
    key = None
    try:
        with transaction.atomic():
            # Serialize owner-scoped receipts across workers. The DB unique constraint
            # is the final guard; two simultaneous retries cannot create two files.
            get_user_model().objects.select_for_update().get(pk=owner.pk)
            get_object_or_404(
                Document.objects.select_for_update(),
                id=audio.document_version.document_id,
                owner=owner,
            )
            audio = get_object_or_404(
                AudioVersion.objects.select_related(
                    "document_version__document"
                ).select_for_update(),
                id=audio.id,
                document_version__document__owner=owner,
            )
            receipt = MemoSubmission.objects.filter(
                owner=owner, client_id=values["client_id"]
            ).first()
            if receipt:
                if receipt.payload_digest != digest:
                    raise Conflict()
                memo = VoiceMemo.objects.filter(submission=receipt).first()
                if not memo:
                    raise Conflict(
                        "この録音は保存後に削除されています。再送では復元できません。"
                    )
                return memo, False
            check_quota(owner, new_memo=True, added_bytes=len(data))
            receipt = MemoSubmission.objects.create(
                owner=owner, client_id=values["client_id"], payload_digest=digest
            )
            key = storage.put_bytes(data, suffix)
            memo = VoiceMemo.objects.create(
                submission=receipt,
                audio_version=audio,
                position_ms=values["position_ms"],
                duration_ms=values["duration_ms"],
                text=values["text"],
                storage_key=key,
                content_type=content_type,
                size_bytes=len(data),
            )
            return memo, True
    except Exception:
        if key:
            storage.delete_key(key)
        raise
