import io
import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import OperationalError
from django.test import TestCase
from django.utils import timezone

from capture.models import GenerationJob, NarrationJob, PdfImport


class OperationsStatusTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user("private-owner")
        self.now = timezone.now()
        common = {
            "owner": self.owner,
            "document_id_snapshot": uuid.uuid4(),
            "version_id_snapshot": uuid.uuid4(),
            "provider": "fixture",
            "character_count": 12,
        }
        self.generation = GenerationJob.objects.create(
            **common, client_id=uuid.uuid4(), budget_day=self.now.date()
        )
        self.narration = NarrationJob.objects.create(
            **common, reading_text="private reading text", state="failed"
        )
        self.pdf = PdfImport.objects.create(
            owner=self.owner,
            client_id=uuid.uuid4(),
            payload_digest="a" * 64,
            suggested_title="private document title",
            extracted_text="private extracted text",
            expires_at=self.now + timedelta(days=1),
            state="running",
            lease_token=uuid.uuid4(),
            lease_expires_at=self.now + timedelta(seconds=120),
        )

    def status(self, **options):
        output = io.StringIO()
        with patch(
            "capture.management.commands.operations_status.timezone.now",
            return_value=self.now,
        ):
            call_command("operations_status", stdout=output, **options)
        return json.loads(output.getvalue())

    def snapshot(self):
        return [
            list(model.objects.order_by("pk").values())
            for model in (GenerationJob, PdfImport, NarrationJob)
        ]

    def test_actual_queue_counts_and_no_private_details_or_writes(self):
        before = self.snapshot()
        report = self.status()
        self.assertTrue(report["healthy"])
        self.assertEqual(report["database"], "ok")
        self.assertEqual(set(report["queues"]), {"generation", "pdf", "narration"})
        self.assertEqual(report["queues"]["generation"]["queued"], 1)
        self.assertEqual(report["queues"]["pdf"]["running"], 1)
        self.assertEqual(report["queues"]["narration"]["failed"], 1)
        self.assertIsNone(report["queues"]["pdf"]["oldest_queued_age_seconds"])
        rendered = json.dumps(report)
        for secret in ("private", str(self.generation.id), str(self.pdf.lease_token)):
            self.assertNotIn(secret, rendered)
        self.assertEqual(self.snapshot(), before)

    def test_old_queued_job_fails_configured_threshold_without_mutation(self):
        GenerationJob.objects.filter(pk=self.generation.pk).update(
            updated_at=self.now - timedelta(seconds=61)
        )
        before = self.snapshot()
        output = io.StringIO()
        with self.assertRaisesMessage(CommandError, "Operations status is unhealthy"):
            call_command("operations_status", max_queued_age_seconds=60, stdout=output)
        report = json.loads(output.getvalue())
        self.assertFalse(report["healthy"])
        self.assertGreater(
            report["queues"]["generation"]["oldest_queued_age_seconds"], 60
        )
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(self.status(max_queued_age_seconds=120)["healthy"])

    def test_recent_narration_requeue_is_not_stale_from_original_creation(self):
        NarrationJob.objects.filter(pk=self.narration.pk).update(
            state="queued",
            created_at=self.now - timedelta(days=1),
            updated_at=self.now - timedelta(seconds=10),
        )
        before = self.snapshot()
        report = self.status(max_queued_age_seconds=60)
        self.assertTrue(report["healthy"])
        self.assertEqual(report["queues"]["narration"]["oldest_queued_age_seconds"], 10)
        self.assertEqual(self.snapshot(), before)

    def test_expired_lease_reports_failure_without_recovering_job(self):
        PdfImport.objects.filter(pk=self.pdf.pk).update(
            lease_expires_at=self.now - timedelta(seconds=1)
        )
        before = self.snapshot()
        output = io.StringIO()
        with self.assertRaises(CommandError):
            call_command("operations_status", stdout=output)
        self.assertEqual(
            json.loads(output.getvalue())["queues"]["pdf"]["expired_leases"], 1
        )
        self.assertEqual(self.snapshot(), before)

    def test_database_failure_is_sanitized_json_and_nonzero(self):
        output = io.StringIO()
        with (
            patch(
                "capture.management.commands.operations_status.connection.cursor",
                side_effect=OperationalError(
                    "password=private-db-secret host=internal"
                ),
            ),
            self.assertRaisesMessage(CommandError, "Operations status is unhealthy"),
        ):
            call_command("operations_status", stdout=output)
        report = json.loads(output.getvalue())
        self.assertEqual(report["database"], "unavailable")
        self.assertFalse(report["healthy"])
        self.assertEqual(report["queues"], {})
        self.assertNotIn("private-db-secret", output.getvalue())
        self.assertNotIn("internal", output.getvalue())
