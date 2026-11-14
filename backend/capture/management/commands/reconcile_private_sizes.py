from django.core.management.base import BaseCommand, CommandError

from capture import storage
from capture.models import AudioSegment
from capture.storage_inventory import sources


class Command(BaseCommand):
    help = "Report mismatched private file sizes; --apply updates metadata (no audio content output)"

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true")

    def handle(self, *args, **options):
        mismatched = missing = immutable = 0
        for model, size_field in sources():
            for item in (
                model.objects.only("id", "storage_key", size_field)
                .exclude(storage_key__isnull=True)
                .exclude(storage_key="")
                .iterator()
            ):
                try:
                    actual = storage.stat(item.storage_key).size_bytes
                except storage.StorageMissing:
                    missing += 1
                    continue
                if actual != getattr(item, size_field):
                    mismatched += 1
                    if model is AudioSegment:
                        # Published segment sizes are part of the immutable timeline.
                        # A changed file needs recovery, never rewriting the receipt.
                        immutable += 1
                        continue
                    if options["apply"]:
                        model.objects.filter(
                            pk=item.pk, storage_key=item.storage_key
                        ).update(**{size_field: actual})
        self.stdout.write(
            f"mismatched_sizes={mismatched} missing_files={missing} immutable_mismatches={immutable} applied={options['apply']}"
        )
        if immutable and options["apply"]:
            raise CommandError(
                "Published segment metadata is immutable; recover the private object."
            )
