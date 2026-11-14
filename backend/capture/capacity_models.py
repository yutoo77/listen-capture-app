"""Conservative reservations before any billable provider request.

Job references are snapshots: deleting a source/user must not release scratch
space while an already running subprocess can still be alive.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q


class TtsCapacityLock(models.Model):
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="tts_capacity_singleton")
        ]


class TtsCapacityReservation(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL
    )
    job_id = models.UUIDField()
    job_kind = models.CharField(max_length=12)
    remaining_bytes = models.PositiveIntegerField()
    scratch_bytes = models.PositiveIntegerField()
    lease_token = models.UUIDField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["job_kind", "job_id"], name="tts_capacity_one_reservation"
            ),
            models.CheckConstraint(
                condition=Q(job_kind__in=["generation", "narration"]),
                name="tts_capacity_kind_valid",
            ),
            models.CheckConstraint(
                condition=Q(scratch_bytes__gt=0), name="tts_capacity_scratch_positive"
            ),
        ]
