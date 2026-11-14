"""PostgreSQL queue with reserved budgets and one remote attempt per job."""

import logging
import uuid
from datetime import timedelta, timezone as datetime_timezone

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import APIException, ValidationError

from . import storage, tts_capacity
from .audio import AudioUnavailable, probe_duration, sniff
from .models import (
    AudioVersion,
    Document,
    DocumentVersion,
    GenerationJob,
    GenerationRequest,
    GlobalTtsBudget,
    NarrationJob,
    UserTtsBudget,
)
from .services import Conflict, check_quota
from .tts_config import configuration, provider_enabled

logger = logging.getLogger("capture.generation")
ACTIVE = ["queued", "running"]


class Disabled(APIException):
    status_code = 503
    default_detail = (
        "音声生成はまだ有効になっていません。管理者による設定と課金承認が必要です。"
    )


class BudgetExceeded(APIException):
    status_code = 429
    default_detail = (
        "本日の音声生成の上限です。UTCの日付が変わってから再試行してください。"
    )


class GenerationFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _receipt(owner, client_id, document_id, version_id):
    receipt = (
        GenerationRequest.objects.filter(owner=owner, client_id=client_id)
        .select_related("job")
        .first()
    )
    if receipt:
        if (
            receipt.document_id_snapshot != document_id
            or receipt.version_id_snapshot != version_id
        ):
            raise Conflict("この送信番号は別の資料または版に使われています。")
        return receipt.job
    return None


def _remember(owner, client_id, document_id, version_id, job):
    GenerationRequest.objects.create(
        owner=owner,
        client_id=client_id,
        document_id_snapshot=document_id,
        version_id_snapshot=version_id,
        job=job,
    )
    return job, False


def enqueue(owner, document_id, version_id, client_id):
    previous = _receipt(owner, client_id, document_id, version_id)
    if previous:
        return previous, False
    document = get_object_or_404(Document, pk=document_id, owner=owner)
    version = document.versions.first()
    if version.id != version_id:
        raise Conflict("本文が更新されています。最新の資料を開いて生成してください。")
    config = configuration()
    if not config["enabled"]:
        raise Disabled()
    if not 1 <= len(version.text) <= settings.TTS_MAX_CHARACTERS:
        raise ValidationError(
            {
                "document_version": "音声生成は3,000文字までです。資料を分けて登録してください。"
            }
        )
    day = timezone.now().astimezone(datetime_timezone.utc).date()
    with transaction.atomic():
        if config["provider"] == "polly":
            tts_capacity.lock()
        # All admissions take the global-day row before the owner/doc rows, so
        # concurrent users cannot over-reserve the last global characters.
        GlobalTtsBudget.objects.get_or_create(day=day)
        global_budget = GlobalTtsBudget.objects.select_for_update().get(day=day)
        get_user_model().objects.select_for_update().get(pk=owner.pk)
        previous = _receipt(owner, client_id, document_id, version_id)
        if previous:
            return previous, False
        document = get_object_or_404(
            Document.objects.select_for_update(), pk=document_id, owner=owner
        )
        version = document.versions.first()
        if version.id != version_id:
            raise Conflict(
                "本文が更新されています。最新の資料を開いて生成してください。"
            )
        existing = (
            GenerationJob.objects.filter(document_version=version)
            .filter(state__in=[*ACTIVE, "succeeded"])
            .first()
        )
        if existing and (existing.state != "succeeded" or existing.audio_version_id):
            return _remember(owner, client_id, document_id, version_id, existing)
        cached = version.audio_versions.filter(kind=config["provider"]).first()
        if cached:
            job = GenerationJob.objects.create(
                owner=owner,
                client_id=client_id,
                document_id_snapshot=document_id,
                version_id_snapshot=version_id,
                document_version=version,
                audio_version=cached,
                provider=config["provider"],
                state="succeeded",
                character_count=0,
                budget_day=day,
            )
            return _remember(owner, client_id, document_id, version_id, job)
        if (
            GenerationJob.objects.filter(owner=owner, state__in=ACTIVE).count()
            + NarrationJob.objects.filter(owner=owner, state__in=ACTIVE).count()
            >= settings.TTS_USER_ACTIVE_JOBS
        ):
            raise Conflict(
                "同時に生成できる資料は3件までです。処理の完了を待ってください。"
            )
        if (
            GenerationJob.objects.filter(state__in=ACTIVE).count()
            + NarrationJob.objects.filter(state__in=ACTIVE).count()
            >= settings.TTS_GLOBAL_ACTIVE_JOBS
        ):
            raise Conflict(
                "音声生成が混み合っています。しばらく待ってから再試行してください。"
            )
        check_quota(owner, added_bytes=1)
        user_budget, _ = UserTtsBudget.objects.get_or_create(owner=owner, day=day)
        count = len(version.text)
        if (
            global_budget.characters_reserved + count
            > settings.TTS_DAILY_GLOBAL_CHARACTERS
            or user_budget.characters_reserved + count
            > settings.TTS_DAILY_USER_CHARACTERS
            or user_budget.requests_reserved >= settings.TTS_DAILY_USER_REQUESTS
        ):
            raise BudgetExceeded()
        for budget in [global_budget, user_budget]:
            budget.characters_reserved += count
            budget.requests_reserved += 1
            budget.save(update_fields=["characters_reserved", "requests_reserved"])
        job = GenerationJob.objects.create(
            owner=owner,
            client_id=client_id,
            document_id_snapshot=document_id,
            version_id_snapshot=version_id,
            document_version=version,
            provider=config["provider"],
            character_count=count,
            budget_day=day,
        )
        tts_capacity.reserve(job)
        GenerationRequest.objects.create(
            owner=owner,
            client_id=client_id,
            document_id_snapshot=document_id,
            version_id_snapshot=version_id,
            job=job,
        )
        return job, True


def expire_leases(owner=None):
    now = timezone.now()
    jobs = GenerationJob.objects.filter(state="running", lease_expires_at__lte=now)
    if owner is not None:
        jobs = jobs.filter(owner=owner)
    return jobs.update(
        state="failed",
        error_code="execution_unknown",
        lease_token=None,
        lease_expires_at=None,
        updated_at=now,
    )


def claim_job():
    expire_leases()
    with transaction.atomic():
        job = (
            GenerationJob.objects.select_for_update(skip_locked=True)
            .filter(state="queued")
            .order_by("created_at")
            .first()
        )
        if not job:
            return None
        if job.document_version_id is None:
            job.state, job.error_code = "failed", "parent_deleted"
        else:
            job.state = "running"
            job.attempt_count = 1
            job.lease_token = uuid.uuid4()
            job.lease_expires_at = timezone.now() + timedelta(
                seconds=settings.TTS_JOB_LEASE_SECONDS
            )
        job.save()
        if job.state == "running":
            tts_capacity.bind(job)
        return job if job.state == "running" else None


def _fail(job_id, token, code):
    GenerationJob.objects.filter(pk=job_id, state="running", lease_token=token).update(
        state="failed",
        error_code=code,
        lease_token=None,
        lease_expires_at=None,
        updated_at=timezone.now(),
    )
    logger.warning("generation_failed job=%s code=%s", job_id, code)


def process_job(job):
    token = job.lease_token
    key = None
    try:
        # A delayed process must not begin another remote call after its lease was
        # cancelled/expired. This check also stops deleted-parent jobs before AWS.
        if not GenerationJob.objects.filter(
            pk=job.pk,
            state="running",
            lease_token=token,
            lease_expires_at__gt=timezone.now(),
        ).exists():
            return
        if not provider_enabled(job.provider):
            raise GenerationFailure("tts_disabled")
        version = DocumentVersion.objects.filter(pk=job.document_version_id).first()
        if version is None:
            raise GenerationFailure("parent_deleted")
        from .polly import synthesize

        tts_capacity.require(job)
        # This includes every network operation; no DB transaction is held here.
        data, content_type, suffix = synthesize(version.text, job.provider)
        if not data or len(data) > 12 * 1024 * 1024:
            raise GenerationFailure("audio_invalid")
        sniff(data, content_type)
        duration = probe_duration(data, suffix)
        if duration >= 570000:
            raise GenerationFailure("audio_too_long")
        with transaction.atomic():
            get_user_model().objects.select_for_update().get(pk=job.owner_id)
            document = (
                Document.objects.select_for_update()
                .filter(pk=job.document_id_snapshot, owner_id=job.owner_id)
                .first()
            )
            current = GenerationJob.objects.select_for_update().get(pk=job.pk)
            if current.state != "running" or current.lease_token != token:
                return
            if current.lease_expires_at <= timezone.now():
                raise GenerationFailure("execution_unknown")
            if document is None or current.document_version_id is None:
                raise GenerationFailure("parent_deleted")
            tts_capacity.consume(current, len(data))
            check_quota(current.owner, added_bytes=len(data))
            try:
                key = storage.put_bytes(data, suffix)
            except OSError as exc:
                raise GenerationFailure("storage_failed") from exc
            audio = AudioVersion.objects.create(
                document_version_id=current.document_version_id,
                kind=current.provider,
                storage_key=key,
                content_type=content_type,
                duration_ms=duration,
                size_bytes=len(data),
            )
            current.audio_version = audio
            current.state, current.error_code = "succeeded", None
            current.lease_token, current.lease_expires_at = None, None
            current.save()
        logger.info("generation_succeeded job=%s provider=%s", job.pk, job.provider)
    except GenerationFailure as exc:
        if key:
            storage.delete_key(key)
        _fail(job.pk, token, exc.code)
    except (ValidationError, AudioUnavailable):
        if key:
            storage.delete_key(key)
        _fail(job.pk, token, "audio_invalid")
    except Conflict:
        if key:
            storage.delete_key(key)
        _fail(job.pk, token, "capacity_exceeded")
    except Exception:
        if key:
            storage.delete_key(key)
        # Do not log exception text: a provider/driver can include source text.
        _fail(job.pk, token, "internal_error")
    finally:
        tts_capacity.release(job)


def work_once():
    job = claim_job()
    if job:
        process_job(job)
        return True
    return False
