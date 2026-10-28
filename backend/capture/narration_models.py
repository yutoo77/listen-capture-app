"""Long narration records; imported at the end of capture.models."""

import uuid

from django.conf import settings
from django.db import models, transaction
from django.db.models import F, Q
from django.db.models.signals import post_delete, pre_delete
from django.dispatch import receiver
from django.utils import timezone


class NarrationJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    document_version = models.ForeignKey(
        "capture.DocumentVersion",
        null=True,
        on_delete=models.SET_NULL,
        related_name="narrations",
    )
    document_id_snapshot = models.UUIDField()
    version_id_snapshot = models.UUIDField()
    reading_text = models.TextField()
    provider = models.CharField(max_length=12)
    voice_settings = models.JSONField(default=dict, db_default={})
    synthesis_profile = models.JSONField(default=dict, db_default={})
    profile_hash = models.CharField(
        max_length=64,
        default="44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        db_default="44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    )
    state = models.CharField(max_length=12, default="queued")
    error_code = models.CharField(max_length=40, null=True)
    cancel_requested_at = models.DateTimeField(null=True)
    character_count = models.PositiveIntegerField()
    audio_version = models.ForeignKey(
        "capture.AudioVersion",
        null=True,
        on_delete=models.SET_NULL,
        related_name="narrations",
    )
    lease_token = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["document_version", "provider", "profile_hash"],
                name="narration_version_provider_profile_unique",
            ),
            models.CheckConstraint(
                condition=Q(character_count__gte=1) & Q(character_count__lte=20000),
                name="narration_characters_bounded",
            ),
            models.CheckConstraint(
                condition=Q(state__in=["queued", "running", "succeeded", "failed"]),
                name="narration_state_valid",
            ),
            models.CheckConstraint(
                condition=Q(provider__in=["polly", "windows", "fixture", "voicevox"]),
                name="narration_provider_valid",
            ),
        ]


class NarrationSegment(models.Model):
    job = models.ForeignKey(
        NarrationJob, on_delete=models.CASCADE, related_name="segments"
    )
    index = models.PositiveIntegerField()
    start_offset = models.PositiveIntegerField()
    end_offset = models.PositiveIntegerField()
    state = models.CharField(max_length=12, default="pending")
    error_code = models.CharField(max_length=40, null=True)
    attempt_count = models.PositiveSmallIntegerField(default=0)
    storage_key = models.CharField(max_length=160, null=True, unique=True)
    size_bytes = models.PositiveIntegerField(default=0)
    frames = models.PositiveIntegerField(default=0)
    digest = models.CharField(max_length=64, default="")
    duration_ms = models.PositiveIntegerField(default=0)
    start_ms = models.PositiveIntegerField(null=True)
    end_ms = models.PositiveIntegerField(null=True)

    class Meta:
        ordering = ["index"]
        constraints = [
            models.UniqueConstraint(
                fields=["job", "index"], name="narration_segment_index_unique"
            ),
            models.CheckConstraint(
                condition=Q(end_offset__gt=F("start_offset"))
                & Q(end_offset__lte=F("start_offset") + 3000),
                name="narration_segment_offsets_bounded",
            ),
            models.CheckConstraint(
                condition=Q(attempt_count__lte=3),
                name="narration_segment_attempts_bounded",
            ),
            models.CheckConstraint(
                condition=Q(
                    state__in=["pending", "running", "succeeded", "failed", "unknown"]
                ),
                name="narration_segment_state_valid",
            ),
        ]


class NarrationRequest(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    job = models.ForeignKey(
        NarrationJob, on_delete=models.CASCADE, related_name="requests"
    )
    operation = models.CharField(max_length=8)
    acknowledge_unknown = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"], name="narration_request_owner_unique"
            )
        ]


@receiver(post_delete, sender=NarrationSegment)
def remove_partial_after_commit(sender, instance, **kwargs):
    if instance.storage_key:
        from . import storage

        transaction.on_commit(lambda key=instance.storage_key: storage.delete_key(key))


@receiver(pre_delete, sender="capture.DocumentVersion")
def erase_deleted_narration_source(sender, instance, **kwargs):
    # Keep request UUID receipts, but erase source text and private partial files.
    jobs = NarrationJob.objects.filter(document_version=instance)
    NarrationSegment.objects.filter(job__in=jobs).delete()
    jobs.update(
        state="failed",
        error_code="parent_deleted",
        reading_text="",
        lease_token=None,
        lease_expires_at=None,
        updated_at=timezone.now(),
    )
