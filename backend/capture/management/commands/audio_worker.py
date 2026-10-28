import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from capture.generation import work_once


class Command(BaseCommand):
    help = "Process PostgreSQL audio jobs; one remote attempt per job, never auto-retry ambiguous work"

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--poll-seconds", type=float, default=2)

    def handle(self, *args, **options):
        try:
            while True:
                close_old_connections()
                worked = work_once()
                if options["once"]:
                    return
                if not worked:
                    time.sleep(max(0.2, min(options["poll_seconds"], 30)))
        except KeyboardInterrupt:
            return
