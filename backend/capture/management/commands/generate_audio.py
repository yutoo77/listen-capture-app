from django.core.management.base import BaseCommand, CommandError

from capture.models import DocumentVersion
from capture.polly import generate_audio


class Command(BaseCommand):
    help = "Queue Polly audio using normal budgets and guards (worker performs the billable request)"

    def add_arguments(self, parser):
        parser.add_argument("version_id")
        parser.add_argument("--confirm-billable", action="store_true")

    def handle(self, *args, **options):
        if not options["confirm_billable"]:
            raise CommandError(
                "Pass --confirm-billable only after approving AWS usage and costs"
            )
        try:
            version = DocumentVersion.objects.get(pk=options["version_id"])
            job = generate_audio(version)
        except (DocumentVersion.DoesNotExist, ValueError, RuntimeError) as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(
            f"generation_job={job.id} state={job.state}; run audio_worker to process"
        )
