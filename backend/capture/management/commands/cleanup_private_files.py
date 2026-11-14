"""Report or remove unreferenced private files older than a conservative grace period."""

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from capture import storage
from capture.storage_inventory import is_referenced, referenced_keys


class Command(BaseCommand):
    help = (
        "Report orphan file count; use --delete to remove orphans older than 24 hours"
    )

    def add_arguments(self, parser):
        parser.add_argument("--delete", action="store_true")

    def handle(self, *args, **options):
        referenced = referenced_keys()
        missing = 0
        for key in referenced:
            try:
                storage.stat(key)
            except storage.StorageMissing:
                missing += 1
        cutoff = timezone.now() - timedelta(hours=24)
        count = failures = 0
        for item in storage.objects():
            if (
                item.key not in referenced
                and item.modified_at < cutoff
                and not is_referenced(item.key)
            ):
                count += 1
                if options["delete"]:
                    failures += not storage.delete_key(item.key)
        self.stdout.write(
            f"orphan_files_older_than_24h={count} deleted={options['delete']} missing_referenced_files={missing} delete_failures={failures}"
        )
