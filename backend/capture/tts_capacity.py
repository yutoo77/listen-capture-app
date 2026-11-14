"""Resource admission for paid Polly and opt-in VOICEVOX synthesis.

Reservations are deliberately pessimistic, not a duration prediction. A crash
or expired lease retains capacity until an operator has stopped all writers;
lease expiry alone cannot prove the old provider subprocess has stopped.
"""

import shutil
import tempfile

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from .capacity_models import TtsCapacityLock, TtsCapacityReservation

LEGACY_BYTES = 12 * 1024 * 1024
NARRATION_BYTES = 16000 * 2 * 60 * 60


def kind(job):
    return "narration" if job._meta.model_name == "narrationjob" else "generation"


def lock():
    """Acquire BEFORE the global-day/owner/document/job locks, inside atomic."""
    TtsCapacityLock.objects.get_or_create(pk=1)
    TtsCapacityLock.objects.select_for_update().get(pk=1)


def _disk_sufficient(extra=0):
    root = getattr(settings, "TTS_CAPACITY_DISK_ROOT", tempfile.gettempdir())
    minimum = getattr(settings, "TTS_CAPACITY_MIN_FREE_BYTES", 256 * 1024 * 1024)
    reserved = TtsCapacityReservation.objects.aggregate(
        total=Sum("scratch_bytes", default=0)
    )["total"]
    try:
        return (
            minimum >= 0 and shutil.disk_usage(root).free >= minimum + reserved + extra
        )
    except OSError:
        return False


def _storage_configured():
    from . import storage
    from .services import Conflict

    try:
        # Configuration only; S3 approval/expected owner/prefix precede payment.
        storage._backend()
    except storage.StorageUnavailable as exc:
        raise Conflict("音声の保存先の設定を確認できません。") from exc


def reserve(job):
    """Caller owns singleton then owner lock. No existing paid job is adopted."""
    if job.provider not in {"polly", "voicevox"}:
        return
    from .services import Conflict, check_quota

    _storage_configured()
    if TtsCapacityReservation.objects.filter(
        job_kind=kind(job), job_id=job.pk
    ).exists():
        raise Conflict(
            "前の処理の容量予約が残っています。管理者による停止確認が必要です。"
        )
    maximum = NARRATION_BYTES if kind(job) == "narration" else LEGACY_BYTES
    partial = (
        job.segments.aggregate(total=Sum("size_bytes", default=0))["total"]
        if kind(job) == "narration"
        else 0
    )
    if (
        kind(job) == "narration"
        and not job.segments.exclude(state="succeeded").exists()
    ):
        # Publication-only retry makes no provider call: all PCM sizes are
        # already known, so do not reserve another hypothetical hour of speech.
        maximum = partial
    remaining = max(0, maximum - partial)
    check_quota(job.owner, added_bytes=remaining)
    # Includes complete PCM plus publication/verification scratch and local
    # private staging. S3 deployments still reserve this conservative bound.
    scratch = max(maximum * 4, 4 * 1024 * 1024)
    if not _disk_sufficient(scratch):
        raise Conflict("音声生成に必要な一時保存容量が不足しています。")
    TtsCapacityReservation.objects.create(
        owner=job.owner,
        job_kind=kind(job),
        job_id=job.pk,
        remaining_bytes=remaining,
        scratch_bytes=scratch,
    )


def bind(job):
    if job.provider in {"polly", "voicevox"}:
        TtsCapacityReservation.objects.filter(
            job_kind=kind(job), job_id=job.pk, lease_token__isnull=True
        ).update(lease_token=job.lease_token)


def require(job):
    """Recheck after queue wait and immediately BEFORE the provider call."""
    if job.provider not in {"polly", "voicevox"}:
        return
    from .services import Conflict, check_quota

    _storage_configured()
    with transaction.atomic():
        get_user_model().objects.select_for_update().get(pk=job.owner_id)
        live_query = type(job).objects.filter(
            pk=job.pk,
            state="running",
            lease_token=job.lease_token,
            lease_expires_at__gt=timezone.now(),
            document_version__isnull=False,
        )
        if hasattr(job, "cancel_requested_at"):
            live_query = live_query.filter(cancel_requested_at__isnull=True)
        live = live_query.exists()
        if (
            not live
            or not TtsCapacityReservation.objects.filter(
                job_kind=kind(job), job_id=job.pk, lease_token=job.lease_token
            ).exists()
            or not _disk_sufficient()
        ):
            raise Conflict("音声生成の容量予約または一時保存容量を確認できません。")
        check_quota(job.owner)


def consume(job, amount):
    """Replace reserved bytes with durable partial bytes under the owner lock."""
    if job.provider not in {"polly", "voicevox"}:
        return
    from .services import Conflict

    reservation = (
        TtsCapacityReservation.objects.select_for_update()
        .filter(job_kind=kind(job), job_id=job.pk, lease_token=job.lease_token)
        .first()
    )
    if reservation is None or amount > reservation.remaining_bytes:
        raise Conflict("音声生成の予約容量を超えています。")
    reservation.remaining_bytes -= amount
    reservation.save(update_fields=["remaining_bytes"])


def release(job):
    """Only the exact completed worker attempt may release its reservation."""
    if job.provider in {"polly", "voicevox"}:
        TtsCapacityReservation.objects.filter(
            job_kind=kind(job), job_id=job.pk, lease_token=job.lease_token
        ).delete()


def status():
    """Aggregate-only operator state. This does not contact AWS or expire jobs."""
    from .models import GenerationJob, NarrationJob

    result = TtsCapacityReservation.objects.aggregate(
        count=Count("pk"),
        remaining_bytes=Sum("remaining_bytes", default=0),
        scratch_bytes=Sum("scratch_bytes", default=0),
    )
    result["abandoned"] = sum(
        TtsCapacityReservation.objects.filter(job_kind=name)
        .exclude(
            job_id__in=model.objects.filter(state__in=["queued", "running"]).values(
                "pk"
            )
        )
        .count()
        for name, model in (("generation", GenerationJob), ("narration", NarrationJob))
    )
    return result
