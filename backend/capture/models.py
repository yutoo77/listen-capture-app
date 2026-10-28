import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class Document(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="documents"
    )
    title = models.CharField(max_length=160)
    is_demo = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        indexes = [models.Index(fields=["owner", "-updated_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["owner"], condition=Q(is_demo=True), name="one_demo_per_owner"
            )
        ]


class ImmutableVersion(models.Model):
    """Application services insert versions; existing versions cannot be edited."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValueError("Versions are immutable; create a new version")
        return super().save(*args, **kwargs)


class DocumentVersion(ImmutableVersion):
    document = models.ForeignKey(
        Document, on_delete=models.CASCADE, related_name="versions"
    )
    number = models.PositiveIntegerField()
    text = models.TextField()

    class Meta:
        ordering = ["-number"]
        constraints = [
            models.UniqueConstraint(
                fields=["document", "number"], name="unique_document_version"
            ),
            models.CheckConstraint(
                condition=Q(number__gte=1), name="document_version_positive"
            ),
        ]


class TextBlock(ImmutableVersion):
    version = models.ForeignKey(
        DocumentVersion, on_delete=models.CASCADE, related_name="text_blocks"
    )
    index = models.PositiveIntegerField()
    start_offset = models.PositiveIntegerField()
    end_offset = models.PositiveIntegerField()
    text = models.TextField()

    class Meta:
        ordering = ["index"]
        constraints = [
            models.UniqueConstraint(
                fields=["version", "index"], name="block_version_index_unique"
            ),
            models.UniqueConstraint(
                fields=["version", "start_offset"], name="block_version_offset_unique"
            ),
            models.CheckConstraint(
                condition=Q(end_offset__gt=models.F("start_offset")),
                name="block_positive_span",
            ),
        ]


class PdfImport(models.Model):
    """Owner-scoped upload and confirmation receipt survives source/doc deletion."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    payload_digest = models.CharField(max_length=64)
    suggested_title = models.CharField(max_length=160)
    storage_key = models.CharField(max_length=160, unique=True, null=True)
    source_size_bytes = models.PositiveIntegerField(default=0)
    state = models.CharField(
        max_length=12,
        default="queued",
        choices=[
            ("queued", "Queued"),
            ("running", "Running"),
            ("succeeded", "Succeeded"),
            ("failed", "Failed"),
        ],
    )
    error_code = models.CharField(max_length=40, null=True)
    extracted_text = models.TextField(blank=True)
    page_count = models.PositiveSmallIntegerField(null=True)
    start_page = models.PositiveSmallIntegerField(null=True)
    end_page = models.PositiveSmallIntegerField(null=True)
    selection_revision = models.PositiveIntegerField(default=0)
    lease_token = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    confirmed_document = models.ForeignKey(
        Document, on_delete=models.SET_NULL, null=True, related_name="pdf_imports"
    )
    confirmed_document_snapshot = models.UUIDField(null=True)
    confirm_client_id = models.UUIDField(null=True)
    confirm_digest = models.CharField(max_length=64, null=True)
    deleted_at = models.DateTimeField(null=True)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["state", "created_at"]),
            models.Index(fields=["owner", "-created_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"], name="pdf_owner_client_unique"
            ),
            models.CheckConstraint(
                condition=Q(source_size_bytes__lte=10485760),
                name="pdf_source_size_bounded",
            ),
            models.CheckConstraint(
                condition=Q(page_count__isnull=True)
                | Q(page_count__gte=1, page_count__lte=200),
                name="pdf_pages_bounded",
            ),
            models.CheckConstraint(
                condition=Q(start_page__isnull=True, end_page__isnull=True)
                | Q(
                    start_page__isnull=False,
                    end_page__isnull=False,
                    page_count__isnull=False,
                    start_page__gte=1,
                    end_page__gte=models.F("start_page"),
                    end_page__lte=models.F("start_page") + 49,
                )
                & Q(end_page__lte=models.F("page_count")),
                name="pdf_selected_pages_bounded",
            ),
        ]


class PdfPageRequest(models.Model):
    """Replay receipts cannot roll a newer draft back to an old page range."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    job = models.ForeignKey(
        PdfImport, on_delete=models.CASCADE, related_name="page_requests"
    )
    start_page = models.PositiveSmallIntegerField()
    end_page = models.PositiveSmallIntegerField()
    base_revision = models.PositiveIntegerField()
    selected_revision = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"], name="pdf_page_owner_client_unique"
            ),
            models.CheckConstraint(
                condition=Q(
                    start_page__gte=1,
                    end_page__gte=models.F("start_page"),
                    end_page__lte=models.F("start_page") + 49,
                )
                & Q(end_page__lte=200),
                name="pdf_page_request_bounded",
            ),
        ]


class AudioVersion(ImmutableVersion):
    document_version = models.ForeignKey(
        DocumentVersion, on_delete=models.CASCADE, related_name="audio_versions"
    )
    kind = models.CharField(
        max_length=12,
        choices=[
            ("demo", "Demo"),
            ("polly", "Polly"),
            ("fixture", "Test fixture"),
            ("windows", "Windows development voice"),
            ("voicevox", "VOICEVOX"),
        ],
    )
    delivery = models.CharField(
        max_length=8,
        default="single",
        choices=[("single", "Single"), ("playlist", "Playlist")],
    )
    synthesis_profile = models.JSONField(default=dict, db_default={})
    storage_key = models.CharField(max_length=160, unique=True, null=True)
    content_type = models.CharField(max_length=80, default="audio/mpeg")
    size_bytes = models.PositiveIntegerField(default=0)
    duration_ms = models.PositiveIntegerField()

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(duration_ms__gt=0), name="audio_duration_positive"
            ),
            models.CheckConstraint(
                condition=Q(delivery="single", storage_key__isnull=False)
                | Q(delivery="playlist", storage_key__isnull=True),
                name="audio_delivery_storage_valid",
            ),
        ]


class AudioSegment(ImmutableVersion):
    """Published assets and timeline belong to the immutable logical audio."""

    audio_version = models.ForeignKey(
        AudioVersion, on_delete=models.CASCADE, related_name="segments"
    )
    index = models.PositiveIntegerField()
    storage_key = models.CharField(max_length=160, unique=True)
    content_type = models.CharField(max_length=80, default="audio/wav")
    size_bytes = models.PositiveIntegerField()
    frames = models.PositiveIntegerField()
    start_ms = models.PositiveIntegerField()
    end_ms = models.PositiveIntegerField()
    duration_ms = models.PositiveIntegerField()
    start_offset = models.PositiveIntegerField()
    end_offset = models.PositiveIntegerField()

    class Meta:
        ordering = ["index"]
        constraints = [
            models.UniqueConstraint(
                fields=["audio_version", "index"], name="audio_segment_index_unique"
            ),
            models.CheckConstraint(
                condition=Q(end_ms__gt=models.F("start_ms"))
                & Q(duration_ms=models.F("end_ms") - models.F("start_ms"))
                & Q(duration_ms__lte=300000),
                name="audio_segment_time_bounded",
            ),
            models.CheckConstraint(
                condition=Q(frames__gte=1, frames__lte=4800000)
                & Q(size_bytes__gte=46, size_bytes__lte=9600044),
                name="audio_segment_data_bounded",
            ),
            models.CheckConstraint(
                condition=Q(end_offset__gt=models.F("start_offset")),
                name="audio_segment_source_positive",
            ),
        ]


class MemoSubmission(models.Model):
    """Owner-scoped idempotency receipt remains a tombstone after memo deletion."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    payload_digest = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"], name="owner_client_id_unique"
            )
        ]


class PlaybackProgress(models.Model):
    """One resume point per immutable audio; ownership follows the document."""

    audio_version = models.OneToOneField(
        AudioVersion,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="playback_progress",
    )
    position_ms = models.PositiveIntegerField()
    revision = models.PositiveBigIntegerField()
    last_client_id = models.UUIDField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(position_ms__gte=0), name="progress_position_nonnegative"
            ),
            models.CheckConstraint(
                condition=Q(revision__gte=1) & Q(revision__lte=9007199254740991),
                name="progress_revision_bounded",
            ),
        ]


class VoiceMemo(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    submission = models.OneToOneField(
        MemoSubmission, on_delete=models.CASCADE, related_name="memo"
    )
    audio_version = models.ForeignKey(
        AudioVersion, on_delete=models.CASCADE, related_name="memos"
    )
    position_ms = models.PositiveIntegerField()
    duration_ms = models.PositiveIntegerField()
    text = models.TextField(blank=True)
    storage_key = models.CharField(max_length=160, unique=True)
    content_type = models.CharField(max_length=80)
    size_bytes = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["audio_version", "-created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=Q(position_ms__gte=0), name="memo_position_nonnegative"
            ),
            models.CheckConstraint(
                condition=Q(duration_ms__gt=0) & Q(duration_ms__lte=60000),
                name="memo_duration_bounded",
            ),
        ]


class GenerationJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    document_id_snapshot = models.UUIDField()
    version_id_snapshot = models.UUIDField()
    document_version = models.ForeignKey(
        DocumentVersion,
        null=True,
        on_delete=models.SET_NULL,
        related_name="generation_jobs",
    )
    audio_version = models.ForeignKey(
        AudioVersion,
        null=True,
        on_delete=models.SET_NULL,
        related_name="generation_jobs",
    )
    provider = models.CharField(
        max_length=12, choices=[("polly", "Polly"), ("fixture", "Test fixture")]
    )
    state = models.CharField(
        max_length=12,
        default="queued",
        choices=[
            ("queued", "Queued"),
            ("running", "Running"),
            ("succeeded", "Succeeded"),
            ("failed", "Failed"),
        ],
    )
    error_code = models.CharField(max_length=40, null=True)
    character_count = models.PositiveIntegerField()
    budget_day = models.DateField()
    lease_token = models.UUIDField(null=True)
    lease_expires_at = models.DateTimeField(null=True)
    attempt_count = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["state", "created_at"]),
            models.Index(fields=["owner", "-created_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"], name="generation_owner_client_unique"
            ),
            models.UniqueConstraint(
                fields=["document_version"],
                condition=Q(state__in=["queued", "running"]),
                name="one_active_generation_per_version",
            ),
            models.CheckConstraint(
                condition=Q(attempt_count__lte=1), name="generation_attempt_once"
            ),
        ]


class GenerationRequest(models.Model):
    """Every request key, including keys which reused an existing job, is durable."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    client_id = models.UUIDField()
    document_id_snapshot = models.UUIDField()
    version_id_snapshot = models.UUIDField()
    job = models.ForeignKey(
        GenerationJob, on_delete=models.CASCADE, related_name="requests"
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "client_id"],
                name="generation_request_owner_key_unique",
            )
        ]


class GlobalTtsBudget(models.Model):
    day = models.DateField(primary_key=True)
    characters_reserved = models.PositiveIntegerField(default=0)
    requests_reserved = models.PositiveIntegerField(default=0)


class UserTtsBudget(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    day = models.DateField()
    characters_reserved = models.PositiveIntegerField(default=0)
    requests_reserved = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "day"], name="user_tts_budget_per_utc_day"
            )
        ]


from .narration_models import NarrationJob, NarrationRequest, NarrationSegment  # noqa: E402,F401
from .capacity_models import TtsCapacityLock, TtsCapacityReservation  # noqa: E402,F401
