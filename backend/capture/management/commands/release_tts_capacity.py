"""Explicit repair after stopping and verifying every worker on the single host."""

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from capture import tts_capacity
from capture.models import GenerationJob, NarrationJob, TtsCapacityReservation


class Command(BaseCommand):
    help = "Release one abandoned paid capacity reservation only after all workers have stopped."

    def add_arguments(self, parser):
        parser.add_argument(
            "--job-kind", choices=["generation", "narration"], required=True
        )
        parser.add_argument("--job-id", type=str, required=True)
        parser.add_argument("--reservation-id", type=int, required=True)
        parser.add_argument("--confirm-no-live-workers", action="store_true")

    def handle(self, *args, **options):
        if not options["confirm_no_live_workers"]:
            raise CommandError(
                "Stop and verify all workers first; --confirm-no-live-workers is required."
            )
        with transaction.atomic():
            tts_capacity.lock()
            try:
                reservation = TtsCapacityReservation.objects.get(
                    pk=options["reservation_id"],
                    job_kind=options["job_kind"],
                    job_id=options["job_id"],
                )
            except (
                TtsCapacityReservation.DoesNotExist,
                ValueError,
                ValidationError,
            ) as exc:
                raise CommandError("The exact reservation was not found.") from exc
            if reservation.owner_id:
                get_user_model().objects.select_for_update().get(
                    pk=reservation.owner_id
                )
            model = (
                NarrationJob if options["job_kind"] == "narration" else GenerationJob
            )
            job = (
                model.objects.select_for_update().filter(pk=reservation.job_id).first()
            )
            if job and job.state not in {"failed", "succeeded"}:
                raise CommandError(
                    "Active/queued jobs cannot have their capacity released."
                )
            reservation.delete()
        self.stdout.write(
            "Released one stopped-worker reservation; no provider request was made."
        )
