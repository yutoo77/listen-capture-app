from django.core.management.base import BaseCommand

from capture.pdf_imports import expire_jobs


class Command(BaseCommand):
    help = "Purge expired unconfirmed PDF originals/drafts after DB commit; keep receipt tombstones"

    def handle(self, *args, **options):
        self.stdout.write(f"expired_pdf_imports={expire_jobs()}")
