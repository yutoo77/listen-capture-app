"""Read-only, aggregate-only database and worker queue health for monitoring."""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, connection
from django.db.models import Count, Min, Q
from django.utils import timezone

from capture.models import GenerationJob, NarrationJob, PdfImport
from capture.tts_capacity import status as capacity_status


class Command(BaseCommand):
    help = "Report database and worker queue health as JSON without changing jobs."

    def add_arguments(self, parser):
        parser.add_argument(
            "--max-queued-age-seconds",
            type=int,
            default=getattr(settings, "OPERATIONS_MAX_QUEUED_AGE_SECONDS", 300),
        )

    def handle(self, *args, **options):
        threshold = options["max_queued_age_seconds"]
        if threshold < 1:
            raise CommandError("Queue age threshold must be a positive integer.")
        report = {
            "database": "ok",
            "healthy": True,
            "max_queued_age_seconds": threshold,
            "queues": {},
            "tts_capacity": {},
        }
        now = timezone.now()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            for name, model in (
                ("generation", GenerationJob),
                ("pdf", PdfImport),
                ("narration", NarrationJob),
            ):
                counts = model.objects.aggregate(
                    queued=Count("pk", filter=Q(state="queued")),
                    running=Count("pk", filter=Q(state="running")),
                    failed=Count("pk", filter=Q(state="failed")),
                    # Explicit retry reuses the same job: measure the wait since
                    # its last queue update, rather than its original creation.
                    oldest=Min("updated_at", filter=Q(state="queued")),
                    expired_leases=Count(
                        "pk",
                        filter=Q(state="running", lease_expires_at__lte=now),
                    ),
                )
                oldest = counts.pop("oldest")
                age = max(0, (now - oldest).total_seconds()) if oldest else None
                counts["oldest_queued_age_seconds"] = (
                    round(age, 3) if age is not None else None
                )
                report["queues"][name] = counts
                if counts["expired_leases"] or (age is not None and age > threshold):
                    report["healthy"] = False
            report["tts_capacity"] = capacity_status()
            if report["tts_capacity"]["abandoned"]:
                report["healthy"] = False
        except DatabaseError:
            # Do not expose connection strings, SQL, text or partial observations.
            report.update(
                database="unavailable", healthy=False, queues={}, tts_capacity={}
            )
        self.stdout.write(json.dumps(report, sort_keys=True))
        if not report["healthy"]:
            raise CommandError("Operations status is unhealthy.")
