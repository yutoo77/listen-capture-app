"""Real PostgreSQL locking plus offline providers; never AWS or metadata calls."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import io
from pathlib import Path
import tempfile
from threading import Barrier
from types import SimpleNamespace
import uuid
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connections
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from capture import generation, narration, narration_provider, services, tts_capacity
from capture.models import GlobalTtsBudget, TtsCapacityReservation

PAID = dict(
    POLLY_ENABLED=True,
    POLLY_BILLING_APPROVED=True,
    LC_E2E_FIXTURE_TTS=False,
    NARRATION_ENCODING="wav",
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
PCM = b"\x01\x00" * 1600


class CapacitySetup:
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting = override_settings(PRIVATE_MEDIA_ROOT=Path(directory.name))
        setting.enable()
        self.addCleanup(setting.disable)
        disk = patch(
            "capture.tts_capacity.shutil.disk_usage",
            return_value=SimpleNamespace(free=10**12),
        )
        disk.start()
        self.addCleanup(disk.stop)
        self.owner = get_user_model().objects.create_user("capacity-owner")
        self.document = services.create_document(
            self.owner, {"title": "合成試験", "text": "日本語の試験。"}
        )
        self.version = self.document.versions.first()

    def enqueue(self, key=None, legacy=False):
        args = (self.owner, self.document.pk, self.version.pk, key or uuid.uuid4())
        return (
            generation.enqueue(*args) if legacy else narration.enqueue(*args, "polly")
        )

    def reconcile(self, job, confirm=True, reservation_id=None):
        return call_command(
            "release_tts_capacity",
            job_kind=tts_capacity.kind(job),
            job_id=str(job.pk),
            reservation_id=reservation_id
            or TtsCapacityReservation.objects.get(job_id=job.pk).pk,
            confirm_no_live_workers=confirm,
            stdout=io.StringIO(),
        )


@override_settings(**PAID)
class PaidCapacityTests(CapacitySetup, TestCase):
    def test_unapproved_storage_is_refused_before_sdk_or_charge(self):
        for legacy in (False, True):
            with (
                self.subTest(legacy=legacy),
                override_settings(
                    PRIVATE_STORAGE_BACKEND="s3", PRIVATE_S3_USE_APPROVED=False
                ),
                patch("boto3.client") as client,
            ):
                with self.assertRaises(services.Conflict):
                    self.enqueue(legacy=legacy)
                client.assert_not_called()
                self.assertFalse(GlobalTtsBudget.objects.exists())
                self.assertFalse(TtsCapacityReservation.objects.exists())

    def test_account_reservation_rejects_before_any_charge_and_rolls_back_budget(self):
        for legacy, maximum in (
            (False, tts_capacity.NARRATION_BYTES),
            (True, tts_capacity.LEGACY_BYTES),
        ):
            with (
                self.subTest(legacy=legacy),
                override_settings(MAX_PRIVATE_BYTES_PER_USER=maximum - 1),
                patch("capture.narration_provider.synthesize") as provider,
            ):
                with self.assertRaises(services.Conflict):
                    self.enqueue(legacy=legacy)
                provider.assert_not_called()
                self.assertFalse(TtsCapacityReservation.objects.exists())
                self.assertFalse(GlobalTtsBudget.objects.exists())

    def test_both_queues_refuse_low_or_unknown_scratch_before_charging(self):
        for legacy in (False, True):
            for disk in (SimpleNamespace(free=1), OSError("private path")):
                with (
                    self.subTest(legacy=legacy, unavailable=isinstance(disk, OSError)),
                    patch(
                        "capture.tts_capacity.shutil.disk_usage",
                        **(
                            {"side_effect": disk}
                            if isinstance(disk, OSError)
                            else {"return_value": disk}
                        ),
                    ),
                ):
                    with self.assertRaises(services.Conflict):
                        self.enqueue(legacy=legacy)
                    self.assertFalse(TtsCapacityReservation.objects.exists())
                    self.assertFalse(GlobalTtsBudget.objects.exists())

    def test_same_key_and_alias_do_not_double_reserve(self):
        key = uuid.uuid4()
        first, _ = self.enqueue(key)
        self.assertEqual(self.enqueue(key)[0].pk, first.pk)
        self.assertEqual(self.enqueue()[0].pk, first.pk)
        self.assertEqual(TtsCapacityReservation.objects.count(), 1)
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    def test_other_uploads_respect_reserved_capacity(self):
        self.enqueue()
        with override_settings(MAX_PRIVATE_BYTES_PER_USER=tts_capacity.NARRATION_BYTES):
            with self.assertRaises(services.Conflict):
                services.create_demo(self.owner)

    def test_worker_rechecks_disk_after_queue_wait_without_calling_provider(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                job, _ = self.enqueue(legacy=legacy)
                with (
                    patch(
                        "capture.tts_capacity.shutil.disk_usage",
                        return_value=SimpleNamespace(free=1),
                    ),
                    patch("capture.narration_provider.synthesize") as narration_call,
                    patch("capture.polly.synthesize") as legacy_call,
                ):
                    (generation if legacy else narration).work_once()
                narration_call.assert_not_called()
                legacy_call.assert_not_called()
                job.refresh_from_db()
                self.assertEqual(job.error_code, "capacity_exceeded")
                self.assertFalse(TtsCapacityReservation.objects.exists())

    def test_worker_rechecks_reduced_user_quota_before_charge(self):
        job, _ = self.enqueue()
        with (
            override_settings(MAX_PRIVATE_BYTES_PER_USER=1),
            patch("capture.narration_provider.synthesize") as provider,
        ):
            narration.work_once()
            provider.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "capacity_exceeded")

    def test_partial_bytes_replace_reservation_without_double_counting(self):
        services.update_document(self.owner, self.document.pk, {"text": "あ" * 3001})
        self.version = self.document.versions.first()
        job, _ = self.enqueue()
        seen = []

        def provider(*args):
            reservation = TtsCapacityReservation.objects.get(job_id=job.pk)
            seen.append(reservation.remaining_bytes)
            services.check_quota(self.owner)
            if len(seen) == 2:
                raise narration_provider.ProviderFailure("execution_unknown")
            return PCM

        with (
            override_settings(MAX_PRIVATE_BYTES_PER_USER=tts_capacity.NARRATION_BYTES),
            patch("capture.narration_provider.synthesize", side_effect=provider),
        ):
            narration.work_once()
        self.assertEqual(
            seen,
            [tts_capacity.NARRATION_BYTES, tts_capacity.NARRATION_BYTES - len(PCM)],
        )
        self.assertFalse(TtsCapacityReservation.objects.exists())
        self.assertEqual(
            job.segments.filter(state="succeeded").get().size_bytes, len(PCM)
        )
        narration.retry(self.owner, job.pk, uuid.uuid4(), acknowledge_unknown=True)
        self.assertEqual(
            TtsCapacityReservation.objects.get().remaining_bytes,
            tts_capacity.NARRATION_BYTES - len(PCM),
        )

    def test_encoding_failure_reuses_completed_pcm_without_another_provider_call(self):
        job, _ = self.enqueue()
        with (
            patch("capture.narration_provider.synthesize", return_value=PCM),
            patch(
                "capture.narration.encode",
                side_effect=narration_provider.ProviderFailure("audio_encoding_failed"),
            ),
        ):
            narration.work_once()
        self.assertFalse(TtsCapacityReservation.objects.exists())
        with (
            override_settings(
                MAX_PRIVATE_BYTES_PER_USER=len(PCM) * 2,
                POLLY_ENABLED=False,
                POLLY_BILLING_APPROVED=False,
            ),
            patch("capture.narration_provider.synthesize") as provider,
        ):
            narration.retry(self.owner, job.pk, uuid.uuid4())
            self.assertEqual(TtsCapacityReservation.objects.get().remaining_bytes, 0)
            narration.work_once()
            provider.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.assertFalse(TtsCapacityReservation.objects.exists())

    def test_expired_lease_holds_capacity_until_explicit_stopped_worker_reconcile(self):
        job, _ = self.enqueue()
        job = narration.claim_job()
        type(job).objects.filter(pk=job.pk).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        narration.expire_leases()
        self.assertTrue(TtsCapacityReservation.objects.exists())
        with self.assertRaises(services.Conflict):
            narration.retry(self.owner, job.pk, uuid.uuid4(), acknowledge_unknown=True)
        with self.assertRaises(CommandError):
            self.reconcile(job, confirm=False)
        with self.assertRaises(CommandError):
            self.reconcile(job, reservation_id=999999)
        self.reconcile(job)
        self.assertFalse(TtsCapacityReservation.objects.exists())
        narration.retry(self.owner, job.pk, uuid.uuid4(), acknowledge_unknown=True)
        fresh = narration.claim_job()
        tts_capacity.release(job)
        self.assertEqual(
            TtsCapacityReservation.objects.get().lease_token, fresh.lease_token
        )

    def test_queued_reservation_cannot_be_released_even_with_confirmation(self):
        job, _ = self.enqueue()
        with self.assertRaises(CommandError):
            self.reconcile(job)
        self.assertTrue(TtsCapacityReservation.objects.exists())

    def test_deleted_source_keeps_inflight_scratch_reservation(self):
        self.enqueue()
        job = narration.claim_job()
        self.document.delete()
        self.assertTrue(TtsCapacityReservation.objects.exists())
        with patch("capture.narration_provider.synthesize") as provider:
            narration.process_job(job)
            provider.assert_not_called()
        self.assertFalse(TtsCapacityReservation.objects.exists())

    def test_capacity_observation_is_aggregate_only_and_reports_abandoned(self):
        job, _ = self.enqueue()
        active = tts_capacity.status()
        self.assertEqual(
            active,
            {
                "count": 1,
                "remaining_bytes": tts_capacity.NARRATION_BYTES,
                "scratch_bytes": tts_capacity.NARRATION_BYTES * 4,
                "abandoned": 0,
            },
        )
        type(job).objects.filter(pk=job.pk).update(state="failed")
        self.assertEqual(tts_capacity.status()["abandoned"], 1)
        self.assertNotIn(str(job.pk), str(tts_capacity.status()))


@override_settings(**PAID)
class CapacityConcurrencyTests(CapacitySetup, TransactionTestCase):
    def concurrently(self, action):
        barrier = Barrier(2)

        def run(index):
            try:
                barrier.wait(timeout=10)
                try:
                    action(index)
                    return "accepted"
                except services.Conflict:
                    return "limited"
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(run, range(2)))

    def test_two_users_cannot_over_reserve_same_host_disk_on_first_admission(self):
        second = get_user_model().objects.create_user("capacity-other")
        other = services.create_document(second, {"title": "別資料", "text": "日本語"})
        options = [(self.owner, self.document), (second, other)]

        def action(index):
            owner, document = options[index]
            narration.enqueue(
                owner, document.pk, document.versions.first().pk, uuid.uuid4(), "polly"
            )

        with patch(
            "capture.tts_capacity.shutil.disk_usage",
            return_value=SimpleNamespace(
                free=settings.TTS_CAPACITY_MIN_FREE_BYTES
                + tts_capacity.NARRATION_BYTES * 4
                + 1
            ),
        ):
            self.assertEqual(sorted(self.concurrently(action)), ["accepted", "limited"])
        self.assertEqual(TtsCapacityReservation.objects.count(), 1)
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    def test_upload_and_reservation_serialize_on_same_owner(self):
        demo_size = (Path(settings.BASE_DIR) / "demo" / "sample.mp3").stat().st_size

        def action(index):
            self.enqueue() if index == 0 else services.create_demo(self.owner)

        with override_settings(
            MAX_PRIVATE_BYTES_PER_USER=tts_capacity.NARRATION_BYTES + demo_size - 1
        ):
            self.assertEqual(sorted(self.concurrently(action)), ["accepted", "limited"])


class PaidCapacityMigrationTests(TransactionTestCase):
    def test_upgrade_and_reverse_refuses_to_drop_any_capacity_before_ddl(self):
        before = ("capture", "0008_pdf_page_selection")
        after = ("capture", "0009_paid_capacity_admission")
        leaves = MigrationExecutor(connection).loader.graph.leaf_nodes()
        try:
            MigrationExecutor(connection).migrate([before])
            executor = MigrationExecutor(connection)
            executor.migrate([after])
            state = executor.loader.project_state([after]).apps
            reservation_model = state.get_model("capture", "TtsCapacityReservation")
            reservation = reservation_model.objects.create(
                job_id=uuid.uuid4(),
                job_kind="narration",
                remaining_bytes=1,
                scratch_bytes=4,
            )
            statements = []

            def observe(execute, sql, params, many, context):
                statements.append(sql)
                return execute(sql, params, many, context)

            with (
                connection.execute_wrapper(observe),
                self.assertRaisesMessage(RuntimeError, "reconcile paid capacity"),
            ):
                MigrationExecutor(connection).migrate([before])
            self.assertFalse(
                any(
                    statement.lstrip().upper().startswith(("DROP ", "ALTER "))
                    for statement in statements
                )
            )
            self.assertTrue(
                reservation_model.objects.filter(pk=reservation.pk).exists()
            )
            reservation.delete()
            MigrationExecutor(connection).migrate([before])
            self.assertNotIn(
                "capture_ttscapacityreservation", connection.introspection.table_names()
            )
        finally:
            MigrationExecutor(connection).migrate(leaves)
