"""Explicitly retried segmented narration. No remote call runs inside a DB lock."""

import hashlib
import logging
import uuid
from datetime import timedelta, timezone as datetime_timezone

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from . import (
    narration_provider as provider,
    services,
    storage,
    tts_capacity,
    voicevox_provider,
)
from .narration_encoding import encode
from .generation import BudgetExceeded, Disabled
from .models import (
    AudioSegment,
    AudioVersion,
    Document,
    GenerationJob,
    GlobalTtsBudget,
    UserTtsBudget,
)
from .narration_models import NarrationJob, NarrationRequest, NarrationSegment
from .services import Conflict

logger = logging.getLogger("capture.narration")
ACTIVE = ["queued", "running"]
LEASE_SECONDS = 180
SINGLE_MAX_FRAMES = provider.SAMPLE_RATE * 600
PUBLISHED_SEGMENT_FRAMES = provider.SAMPLE_RATE * 300


class MissingPartial(provider.ProviderFailure):
    def __init__(self, segment_id):
        self.segment_id = segment_id
        super().__init__("storage_failed")


def split_ranges(text, blocks, max_characters=3000):
    """Cover every original code point exactly, preferring immutable block ends."""
    ends = sorted({block.end_offset for block in blocks})
    result, start = [], 0
    while start < len(text):
        cap = min(start + max_characters, len(text))
        end = max((point for point in ends if start < point <= cap), default=cap)
        result.append((start, end))
        start = end
    return result


def _receipt(
    owner,
    key,
    *,
    operation,
    job_id=None,
    document_id=None,
    version_id=None,
    selected_provider=None,
    selected_voice=None,
    acknowledge=False,
):
    receipt = (
        NarrationRequest.objects.filter(owner=owner, client_id=key)
        .select_related("job")
        .first()
    )
    if not receipt:
        return None
    job = receipt.job
    if (
        receipt.operation != operation
        or receipt.acknowledge_unknown != acknowledge
        or (job_id is not None and job.id != job_id)
        or (document_id is not None and job.document_id_snapshot != document_id)
        or (version_id is not None and job.version_id_snapshot != version_id)
        or (selected_provider is not None and job.provider != selected_provider)
        or (selected_voice is not None and job.voice_settings != selected_voice)
    ):
        raise Conflict("この送信番号は別の依頼に使われています。")
    return job


def _remember(owner, key, job, operation, acknowledge=False):
    NarrationRequest.objects.create(
        owner=owner,
        client_id=key,
        job=job,
        operation=operation,
        acknowledge_unknown=acknowledge,
    )


def _admission(owner, count, day):
    """Caller holds global-day then owner locks, matching the legacy queue."""
    global_budget = GlobalTtsBudget.objects.get(day=day)
    user_budget, _ = UserTtsBudget.objects.get_or_create(owner=owner, day=day)
    if (
        global_budget.characters_reserved + count > settings.TTS_DAILY_GLOBAL_CHARACTERS
        or user_budget.characters_reserved + count > settings.TTS_DAILY_USER_CHARACTERS
        or user_budget.requests_reserved >= settings.TTS_DAILY_USER_REQUESTS
    ):
        raise BudgetExceeded()
    if (
        NarrationJob.objects.filter(owner=owner, state__in=ACTIVE).count()
        + GenerationJob.objects.filter(owner=owner, state__in=ACTIVE).count()
        >= settings.TTS_USER_ACTIVE_JOBS
    ):
        raise Conflict("処理中の音声生成が上限です。完了を待ってください。")
    if (
        NarrationJob.objects.filter(state__in=ACTIVE).count()
        + GenerationJob.objects.filter(state__in=ACTIVE).count()
        >= settings.TTS_GLOBAL_ACTIVE_JOBS
    ):
        raise Conflict("音声生成が混み合っています。")
    services.check_quota(owner, added_bytes=1)
    for budget in [global_budget, user_budget]:
        budget.characters_reserved += count
        budget.requests_reserved += 1
        budget.save(update_fields=["characters_reserved", "requests_reserved"])


def _lock_budget_owner(owner):
    day = timezone.now().astimezone(datetime_timezone.utc).date()
    GlobalTtsBudget.objects.get_or_create(day=day)
    GlobalTtsBudget.objects.select_for_update().get(day=day)
    get_user_model().objects.select_for_update().get(pk=owner.pk)
    return day


def enqueue(owner, document_id, version_id, client_id, selected_provider, voice=None):
    selected_voice = voicevox_provider.normalize_voice(selected_provider, voice)
    options = dict(
        operation="start",
        document_id=document_id,
        version_id=version_id,
        selected_provider=selected_provider,
        selected_voice=selected_voice,
    )
    previous = _receipt(owner, client_id, **options)
    if previous:
        return previous, False
    # Authorize before disclosing provider configuration or doing segmentation.
    get_object_or_404(Document, id=document_id, owner=owner)
    if not provider.enabled(selected_provider):
        raise Disabled()
    try:
        synthesis_profile = (
            voicevox_provider.synthesis_profile(selected_voice)
            if selected_provider == "voicevox"
            else {}
        )
    except provider.ProviderFailure as error:
        raise Disabled() from error
    synthesis_hash = voicevox_provider.profile_hash(synthesis_profile)
    with transaction.atomic():
        if selected_provider in {"polly", "voicevox"}:
            tts_capacity.lock()
        day = _lock_budget_owner(owner)
        previous = _receipt(owner, client_id, **options)
        if previous:
            return previous, False
        document = get_object_or_404(
            Document.objects.select_for_update(), id=document_id, owner=owner
        )
        version = document.versions.first()
        if version.id != version_id:
            raise Conflict("本文が更新されています。最新の版を開いてください。")
        existing = NarrationJob.objects.filter(
            document_version=version,
            provider=selected_provider,
            profile_hash=synthesis_hash,
        ).first()
        if existing:
            _remember(owner, client_id, existing, "start")
            return existing, False
        if not 1 <= len(version.text) <= 20000:
            raise ValidationError(
                {"document_version": "音声生成は20,000文字以内です。"}
            )
        blocks = services.ensure_text_blocks(version)
        _admission(owner, len(version.text), day)
        job = NarrationJob.objects.create(
            owner=owner,
            document_version=version,
            document_id_snapshot=document_id,
            version_id_snapshot=version_id,
            reading_text=version.text,
            provider=selected_provider,
            voice_settings=selected_voice,
            synthesis_profile=synthesis_profile,
            profile_hash=synthesis_hash,
            character_count=len(version.text),
        )
        NarrationSegment.objects.bulk_create(
            [
                NarrationSegment(
                    job=job, index=index, start_offset=start, end_offset=end
                )
                for index, (start, end) in enumerate(
                    split_ranges(
                        version.text,
                        blocks,
                        provider.POLLY_SEGMENT_MAX_CHARACTERS
                        if selected_provider == "polly"
                        else voicevox_provider.SEGMENT_CHARACTERS
                        if selected_provider == "voicevox"
                        else 3000,
                    )
                )
            ]
        )
        tts_capacity.reserve(job)
        _remember(owner, client_id, job, "start")
        return job, True


def retry(owner, job_id, client_id, acknowledge_unknown=False):
    options = dict(operation="retry", job_id=job_id, acknowledge=acknowledge_unknown)
    previous = _receipt(owner, client_id, **options)
    if previous:
        return previous, False
    owned = get_object_or_404(NarrationJob, id=job_id, owner=owner)
    provider_available = provider.enabled(owned.provider)
    with transaction.atomic():
        if owned.provider in {"polly", "voicevox"}:
            tts_capacity.lock()
        day = _lock_budget_owner(owner)
        previous = _receipt(owner, client_id, **options)
        if previous:
            return previous, False
        get_object_or_404(
            Document.objects.select_for_update(),
            pk=owned.document_id_snapshot,
            owner=owner,
        )
        job = NarrationJob.objects.select_for_update().get(pk=job_id, owner=owner)
        if job.state != "failed":
            _remember(owner, client_id, job, "retry", acknowledge_unknown)
            return job, False
        remaining = list(job.segments.exclude(state="succeeded"))
        # Publishing already generated PCM makes no provider request or charge.
        if remaining and not provider_available:
            raise Disabled()
        if (
            any(segment.state == "unknown" for segment in remaining)
            and not acknowledge_unknown
        ):
            raise Conflict(
                "結果不明の区間は既に課金・生成済みの可能性があります。追加実行への確認が必要です。"
            )
        if any(segment.attempt_count >= 3 for segment in remaining):
            raise Conflict("この区間の実行回数が上限です。管理者へ確認してください。")
        _admission(
            owner,
            sum(segment.end_offset - segment.start_offset for segment in remaining),
            day,
        )
        tts_capacity.reserve(job)
        job.segments.exclude(state="succeeded").update(state="pending", error_code=None)
        job.state, job.error_code = "queued", None
        job.cancel_requested_at = None
        job.lease_token, job.lease_expires_at = None, None
        job.save()
        _remember(owner, client_id, job, "retry", acknowledge_unknown)
        return job, True


def _finish_cancel(current):
    """Caller holds the job lock and has no provider call left in progress."""
    current.state, current.error_code = "failed", "user_cancelled"
    current.lease_token, current.lease_expires_at = None, None
    current.save()


def cancel(owner, job_id):
    """Idempotent per job; an in-flight bounded call keeps its admission slot.

    Workers retain a successful current PCM result before acknowledging the
    request. Only that worker releases its reservation after leaving the call.
    """
    owned = get_object_or_404(NarrationJob, id=job_id, owner=owner)
    with transaction.atomic():
        if owned.provider in {"polly", "voicevox"}:
            tts_capacity.lock()
        get_user_model().objects.select_for_update().get(pk=owner.pk)
        Document.objects.select_for_update().filter(
            pk=owned.document_id_snapshot, owner=owner
        ).first()
        current = NarrationJob.objects.select_for_update().get(pk=job_id, owner=owner)
        if current.state not in ACTIVE:
            return current
        if current.cancel_requested_at is None:
            current.cancel_requested_at = timezone.now()
        if current.state == "queued":
            # The row lock excludes claim_job, so no provider can own this job.
            tts_capacity.release(current)
            _finish_cancel(current)
        else:
            current.save(update_fields=["cancel_requested_at", "updated_at"])
        return current


def expire_leases(owner=None):
    with transaction.atomic():
        query = NarrationJob.objects.select_for_update().filter(
            state="running", lease_expires_at__lte=timezone.now()
        )
        if owner is not None:
            query = query.filter(owner=owner)
        for job in query:
            job.segments.filter(state="running").update(
                state="unknown", error_code="execution_unknown"
            )
            job.state, job.error_code = (
                "failed",
                "user_cancelled" if job.cancel_requested_at else "execution_unknown",
            )
            job.lease_token, job.lease_expires_at = None, None
            job.save()


def claim_job():
    expire_leases()
    with transaction.atomic():
        job = (
            NarrationJob.objects.select_for_update(skip_locked=True)
            .filter(state="queued")
            .order_by("created_at")
            .first()
        )
        if not job:
            return None
        job.state, job.lease_token = "running", uuid.uuid4()
        job.lease_expires_at = timezone.now() + timedelta(seconds=LEASE_SECONDS)
        job.save()
        tts_capacity.bind(job)
        return job


def _locked(job, token, *, preserve_inflight=False):
    get_user_model().objects.select_for_update().get(pk=job.owner_id)
    document = (
        Document.objects.select_for_update()
        .filter(pk=job.document_id_snapshot, owner_id=job.owner_id)
        .first()
    )
    current = NarrationJob.objects.select_for_update().get(pk=job.pk)
    if current.state != "running" or current.lease_token != token:
        return None
    if not document or current.document_version_id is None:
        raise provider.ProviderFailure("parent_deleted")
    if current.lease_expires_at <= timezone.now():
        raise provider.ProviderFailure("execution_unknown")
    if current.cancel_requested_at and not preserve_inflight:
        _finish_cancel(current)
        return None
    return current


def _fail(job_id, token, code, segment_id=None):
    with transaction.atomic():
        current = (
            NarrationJob.objects.select_for_update()
            .filter(pk=job_id, state="running", lease_token=token)
            .first()
        )
        if not current:
            return
        if segment_id is not None:
            segment = current.segments.get(pk=segment_id)
            old_key = segment.storage_key
            segment.state, segment.error_code = "failed", "storage_failed"
            segment.storage_key, segment.size_bytes = None, 0
            segment.frames, segment.duration_ms = 0, 0
            segment.save()
            if old_key:
                transaction.on_commit(
                    lambda old_key=old_key: storage.delete_key(old_key)
                )
        current.segments.filter(state="running").update(
            state="unknown" if code == "execution_unknown" else "failed",
            error_code=code,
        )
        current.state, current.error_code = (
            "failed",
            "user_cancelled" if current.cancel_requested_at else code,
        )
        current.lease_token, current.lease_expires_at = None, None
        current.save()
    logger.warning("narration_failed job=%s code=%s", job_id, code)


def _milliseconds(frames):
    return (frames * 1000 + provider.SAMPLE_RATE - 1) // provider.SAMPLE_RATE


def _publish(job, token):
    tts_capacity.require(job)
    frames = sum(job.segments.values_list("frames", flat=True))
    if frames * 2 > provider.MAX_TOTAL_BYTES:
        raise provider.ProviderFailure("audio_too_long")
    if frames > SINGLE_MAX_FRAMES:
        return _publish_playlist(job, token)
    return _publish_single(job, token)


def _publish_playlist(job, token):
    """Stage bounded files outside locks, then publish one atomic immutable set.

    A provider partial may span several physical assets. Its source character
    span stays coarse rather than inventing word-level timing within that text.
    """
    segments = list(job.segments.all())
    fingerprint = [
        (s.pk, s.storage_key, s.size_bytes, s.frames, s.digest, s.state)
        for s in segments
    ]
    staged = []
    frames = 0
    try:
        for partial in segments:
            if partial.state != "succeeded" or not partial.storage_key:
                raise provider.ProviderFailure("audio_invalid")
            try:
                data = storage.read_bytes(
                    partial.storage_key, max_bytes=provider.MAX_SEGMENT_BYTES
                )
            except FileNotFoundError as exc:
                raise MissingPartial(partial.pk) from exc
            if (
                len(data) != partial.size_bytes
                or len(data) != partial.frames * 2
                or hashlib.sha256(data).hexdigest() != partial.digest
            ):
                raise MissingPartial(partial.pk)
            partial.start_ms = _milliseconds(frames)
            for offset in range(0, partial.frames, PUBLISHED_SEGMENT_FRAMES):
                chunk_frames = min(PUBLISHED_SEGMENT_FRAMES, partial.frames - offset)
                encoded = encode(data[offset * 2 : (offset + chunk_frames) * 2])
                key = storage.put_bytes(encoded.data, encoded.suffix)
                start = _milliseconds(frames)
                frames += chunk_frames
                end = _milliseconds(frames)
                staged.append(
                    dict(
                        storage_key=key,
                        index=len(staged),
                        size_bytes=len(encoded.data),
                        content_type=encoded.content_type,
                        frames=chunk_frames,
                        start_ms=start,
                        end_ms=end,
                        duration_ms=end - start,
                        start_offset=partial.start_offset,
                        end_offset=partial.end_offset,
                    )
                )
                # Renew only our live token; slow private storage never holds
                # database locks, and a stale/deleted worker cannot publish.
                with transaction.atomic():
                    current = _locked(job, token)
                    if not current:
                        return False
                    current.lease_expires_at = timezone.now() + timedelta(
                        seconds=LEASE_SECONDS
                    )
                    current.save(update_fields=["lease_expires_at", "updated_at"])
            partial.end_ms = _milliseconds(frames)
        if not frames:
            raise provider.ProviderFailure("audio_invalid")
        with transaction.atomic():
            current = _locked(job, token)
            if not current:
                return False
            actual = list(
                current.segments.values_list(
                    "pk", "storage_key", "size_bytes", "frames", "digest", "state"
                )
            )
            if actual != fingerprint:
                raise provider.ProviderFailure("audio_invalid")
            total_size = sum(item["size_bytes"] for item in staged)
            tts_capacity.release(current)
            services.check_quota(
                current.owner,
                added_bytes=total_size - sum(item.size_bytes for item in segments),
            )
            audio = AudioVersion.objects.create(
                document_version_id=current.document_version_id,
                kind=current.provider,
                synthesis_profile=current.synthesis_profile,
                delivery="playlist",
                storage_key=None,
                content_type=staged[0]["content_type"],
                size_bytes=total_size,
                duration_ms=_milliseconds(frames),
            )
            AudioSegment.objects.bulk_create(
                [AudioSegment(audio_version=audio, **item) for item in staged]
            )
            # Once committed these keys belong to durable rows, even if a
            # later old-partial cleanup callback itself fails or is interrupted.
            transaction.on_commit(staged.clear)
            for partial in segments:
                old_key = partial.storage_key
                partial.storage_key, partial.size_bytes = None, 0
                partial.save(
                    update_fields=["storage_key", "size_bytes", "start_ms", "end_ms"]
                )
                transaction.on_commit(
                    lambda old_key=old_key: storage.delete_key(old_key)
                )
            current.audio_version, current.state, current.error_code = (
                audio,
                "succeeded",
                None,
            )
            current.lease_token, current.lease_expires_at = None, None
            current.save()
        staged = []
        return True
    finally:
        for item in staged:
            storage.delete_key(item["storage_key"])


def _publish_single(job, token):
    # Immutable successful partials can be read without row locks. Recheck the
    # lease and parent after storage work, before publishing any DB reference.
    segments = list(job.segments.all())
    fingerprint = [
        (
            item.pk,
            item.storage_key,
            item.size_bytes,
            item.frames,
            item.digest,
            item.state,
        )
        for item in segments
    ]
    pcm = bytearray()
    frames = 0
    for segment in segments:
        if segment.state != "succeeded" or not segment.storage_key:
            raise provider.ProviderFailure("audio_invalid")
        try:
            data = storage.read_bytes(
                segment.storage_key, max_bytes=provider.MAX_SEGMENT_BYTES
            )
        except FileNotFoundError as exc:
            raise MissingPartial(segment.pk) from exc
        if (
            len(data) != segment.size_bytes
            or len(data) != segment.frames * 2
            or hashlib.sha256(data).hexdigest() != segment.digest
        ):
            raise MissingPartial(segment.pk)
        segment.start_ms = _milliseconds(frames)
        frames += segment.frames
        segment.end_ms = (
            frames * 1000 + provider.SAMPLE_RATE - 1
        ) // provider.SAMPLE_RATE
        pcm.extend(data)
        if len(pcm) > provider.MAX_TOTAL_BYTES:
            raise provider.ProviderFailure("audio_too_long")
    if not frames:
        raise provider.ProviderFailure("audio_invalid")
    encoded = encode(pcm)
    data = encoded.data
    key = None
    staged = []
    try:
        key = storage.put_bytes(data, encoded.suffix)
        staged.append(key)
        with transaction.atomic():
            current = _locked(job, token)
            if not current:
                return False
            actual = list(
                current.segments.values_list(
                    "pk", "storage_key", "size_bytes", "frames", "digest", "state"
                )
            )
            if actual != fingerprint:
                raise provider.ProviderFailure("audio_invalid")
            # Partial files are replaced by the final file. Their bytes already
            # participate in check_quota; account for the net persisted increase.
            tts_capacity.release(current)
            services.check_quota(
                current.owner,
                added_bytes=len(data) - sum(item.size_bytes for item in segments),
            )
            audio = AudioVersion.objects.create(
                document_version_id=current.document_version_id,
                kind=current.provider,
                synthesis_profile=current.synthesis_profile,
                storage_key=key,
                content_type=encoded.content_type,
                size_bytes=len(data),
                duration_ms=(frames * 1000 + provider.SAMPLE_RATE - 1)
                // provider.SAMPLE_RATE,
            )
            # Transfer ownership at DB commit before any fallible old-partial
            # cleanup callback. An interrupt there must not delete live media.
            transaction.on_commit(staged.clear)
            for segment in segments:
                old_key = segment.storage_key
                segment.storage_key, segment.size_bytes = None, 0
                segment.save(
                    update_fields=["storage_key", "size_bytes", "start_ms", "end_ms"]
                )
                transaction.on_commit(
                    lambda old_key=old_key: storage.delete_key(old_key)
                )
            current.audio_version, current.state, current.error_code = (
                audio,
                "succeeded",
                None,
            )
            current.lease_token, current.lease_expires_at = None, None
            current.save()
        staged.clear()
        return True
    finally:
        for staged_key in staged:
            storage.delete_key(staged_key)


def process_job(job):
    token = job.lease_token
    key = None
    try:
        while True:
            # Windows discovery may start a bounded PowerShell process. Never
            # hold account/document/job locks while probing the local provider.
            provider_available = provider.enabled(job.provider)
            with transaction.atomic():
                current = _locked(job, token)
                if not current:
                    return
                segment = current.segments.filter(state="pending").first()
                if segment is None:
                    break
                if not provider_available:
                    raise provider.ProviderFailure("tts_disabled")
                segment.state, segment.attempt_count = (
                    "running",
                    segment.attempt_count + 1,
                )
                segment.save(update_fields=["state", "attempt_count"])
                current.lease_expires_at = timezone.now() + timedelta(
                    seconds=LEASE_SECONDS
                )
                current.save(update_fields=["lease_expires_at", "updated_at"])
                text = current.reading_text[segment.start_offset : segment.end_offset]
            # One provider attempt only. SDK retries and engine fallback disabled.
            tts_capacity.require(job)
            data = (
                voicevox_provider.synthesize(text, current.synthesis_profile)
                if job.provider == "voicevox"
                else provider.synthesize(text, job.provider)
            )
            if not data or len(data) % 2 or len(data) > provider.MAX_SEGMENT_BYTES:
                raise provider.ProviderFailure("audio_invalid")
            if (
                job.provider == "polly"
                and len(data) // 2 >= provider.POLLY_SEGMENT_MAX_FRAMES
            ):
                raise provider.ProviderFailure("audio_too_long")
            key = storage.put_bytes(data, "pcm")
            with transaction.atomic():
                current = _locked(job, token, preserve_inflight=True)
                if not current:
                    return
                partial_bytes = current.segments.aggregate(
                    total=Sum("size_bytes", default=0)
                )["total"]
                if partial_bytes + len(data) > provider.MAX_TOTAL_BYTES:
                    raise provider.ProviderFailure("audio_too_long")
                tts_capacity.consume(current, len(data))
                services.check_quota(current.owner, added_bytes=len(data))
                segment.state, segment.storage_key, segment.size_bytes = (
                    "succeeded",
                    key,
                    len(data),
                )
                segment.frames = len(data) // 2
                segment.digest = hashlib.sha256(data).hexdigest()
                segment.duration_ms = (
                    segment.frames * 1000 + provider.SAMPLE_RATE - 1
                ) // provider.SAMPLE_RATE
                segment.error_code = None
                segment.save()
            key = None
        if _publish(job, token):
            logger.info("narration_succeeded job=%s provider=%s", job.pk, job.provider)
    except provider.ProviderFailure as exc:
        _fail(job.pk, token, exc.code, getattr(exc, "segment_id", None))
    except Conflict:
        _fail(job.pk, token, "capacity_exceeded")
    except Exception:
        # Unexpected failure after a provider call may already be billable.
        _fail(job.pk, token, "execution_unknown")
    finally:
        if key:
            storage.delete_key(key)
        tts_capacity.release(job)


def work_once():
    job = claim_job()
    if job:
        process_job(job)
        return True
    return False
