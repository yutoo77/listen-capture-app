import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError, ReadTimeoutError
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from capture import generation, services, storage
from capture.models import (
    AudioVersion,
    GenerationJob,
    GenerationRequest,
    GlobalTtsBudget,
    UserTtsBudget,
)
from capture.polly import synthesize
from capture.tts_config import configuration

FIXTURE = {
    "LC_E2E_FIXTURE_TTS": True,
    "LC_TEST_ENVIRONMENT": True,
    "AWS_METADATA_DISABLED": True,
    "DEBUG": True,
    "POLLY_ENABLED": False,
    "POLLY_BILLING_APPROVED": False,
    "PASSWORD_HASHERS": ["django.contrib.auth.hashers.MD5PasswordHasher"],
}


@override_settings(**FIXTURE)
class GenerationTests(TestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.directory = tempfile.TemporaryDirectory()
        self.setting = override_settings(PRIVATE_MEDIA_ROOT=Path(self.directory.name))
        self.setting.enable()
        self.addCleanup(self.setting.disable)
        self.addCleanup(self.directory.cleanup)
        self.owner = get_user_model().objects.create_user(
            "tts-owner", password="test-password"
        )
        self.other = get_user_model().objects.create_user(
            "tts-other", password="test-password"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.foreign = APIClient()
        self.foreign.force_authenticate(self.other)
        self.document = services.create_document(
            self.owner, {"title": "音声生成", "text": "短い日本語の文章。"}
        )
        self.version = self.document.versions.first()
        self.url = f"/api/documents/{self.document.id}/audio-generation/"

    def request_generation(self, *, key=None, version=None, client=None):
        return (client or self.client).post(
            self.url,
            {
                "document_version": str(version or self.version.id),
                "client_id": str(key or uuid.uuid4()),
            },
            format="json",
        )

    def queued(self):
        response = self.request_generation()
        self.assertEqual(response.status_code, 202, response.data)
        return GenerationJob.objects.get(pk=response.data["id"])

    def test_enabled_fixture_metadata_is_truthful_and_has_no_network(self):
        with patch("capture.polly.boto3.client") as client:
            data = self.client.get("/api/session/").json()
            self.assertTrue(data["ttsAvailable"])
            self.assertEqual(data["tts"]["provider"], "fixture")
            self.assertEqual(data["tts"]["price_per_million_usd"], 0)
            self.queued()
            generation.work_once()
            client.assert_not_called()

    def test_queue_worker_status_and_private_audio_success(self):
        job = self.queued()
        self.assertEqual(job.state, "queued")
        self.assertEqual(
            self.client.get(f"/api/documents/{self.document.id}/").data[
                "audio_generation"
            ]["id"],
            str(job.id),
        )
        self.assertTrue(generation.work_once())
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.assertEqual(job.attempt_count, 1)
        self.assertEqual(job.audio_version.kind, "fixture")
        self.assertEqual(job.audio_version.duration_ms, 1000)
        response = self.client.get(
            f"/api/audio/{job.audio_version_id}/content/", HTTP_RANGE="bytes=0-10"
        )
        self.assertEqual(response.status_code, 206)
        self.assertEqual(len(b"".join(response.streaming_content)), 11)
        self.assertEqual(
            self.client.get(f"/api/audio-generations/{job.id}/").data["state"],
            "succeeded",
        )
        self.assertFalse(generation.work_once())

    def test_foreign_anonymous_and_parent_id_swap_rejected(self):
        self.assertEqual(self.request_generation(client=self.foreign).status_code, 404)
        anonymous = APIClient()
        self.assertEqual(self.request_generation(client=anonymous).status_code, 403)
        other_doc = services.create_document(
            self.other, {"title": "別資料", "text": "別の本文"}
        )
        self.assertEqual(
            self.request_generation(version=other_doc.versions.first().id).status_code,
            409,
        )
        job = self.queued()
        self.assertEqual(
            self.foreign.get(f"/api/audio-generations/{job.id}/").status_code, 404
        )
        self.assertEqual(
            anonymous.get(f"/api/audio-generations/{job.id}/").status_code, 403
        )

    def test_csrf_and_strict_input(self):
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.owner)
        self.assertEqual(
            client.post(
                self.url,
                {
                    "document_version": str(self.version.id),
                    "client_id": str(uuid.uuid4()),
                },
            ).status_code,
            403,
        )
        for body in [
            {"document_version": str(self.version.id)},
            {"document_version": str(self.version.id), "client_id": "bad"},
            {
                "document_version": str(self.version.id),
                "client_id": str(uuid.uuid4()),
                "owner": self.other.pk,
            },
        ]:
            self.assertEqual(
                self.client.post(self.url, body, format="json").status_code, 400
            )

    @override_settings(
        LC_E2E_FIXTURE_TTS=False, POLLY_ENABLED=True, POLLY_BILLING_APPROVED=False
    )
    def test_enable_without_billing_approval_remains_disabled(self):
        with patch("capture.polly.boto3.client") as client:
            self.assertFalse(configuration()["enabled"])
            self.assertEqual(self.request_generation().status_code, 503)
            client.assert_not_called()
        self.assertFalse(GlobalTtsBudget.objects.exists())

    @override_settings(
        LC_E2E_FIXTURE_TTS=False, POLLY_ENABLED=False, POLLY_BILLING_APPROVED=True
    )
    def test_billing_approval_without_enable_remains_disabled(self):
        self.assertEqual(self.request_generation().status_code, 503)

    @override_settings(LC_TEST_ENVIRONMENT=False)
    def test_fixture_cannot_run_without_all_guards(self):
        self.assertEqual(self.request_generation().status_code, 503)

    def test_character_limit_counts_unicode_code_points(self):
        services.update_document(self.owner, self.document.id, {"text": "あ" * 3001})
        self.version = self.document.versions.first()
        self.assertEqual(self.request_generation().status_code, 400)
        services.update_document(self.owner, self.document.id, {"text": "😀" * 3000})
        self.version = self.document.versions.first()
        self.assertEqual(self.request_generation().status_code, 202)
        self.assertEqual(GlobalTtsBudget.objects.get().characters_reserved, 3000)

    def test_stale_version_rejected_and_old_job_keeps_original_version(self):
        job = self.queued()
        services.update_document(self.owner, self.document.id, {"text": "新しい本文"})
        self.assertEqual(self.request_generation().status_code, 409)
        generation.work_once()
        job.refresh_from_db()
        self.assertEqual(job.audio_version.document_version_id, self.version.id)
        detail = self.client.get(f"/api/documents/{self.document.id}/").data
        self.assertIsNone(detail["audio_generation"])
        self.assertNotEqual(detail["current_version"]["id"], str(self.version.id))

    def test_same_key_and_aliases_reuse_jobs_without_new_budget(self):
        first_key, alias_key = uuid.uuid4(), uuid.uuid4()
        first = self.request_generation(key=first_key)
        second = self.request_generation(key=alias_key)
        self.assertEqual((first.status_code, second.status_code), (202, 200))
        self.assertEqual(first.data["id"], second.data["id"])
        job = GenerationJob.objects.get()
        job.state, job.error_code = "failed", "execution_unknown"
        job.save()
        self.assertEqual(
            self.request_generation(key=alias_key).data["id"], first.data["id"]
        )
        self.assertEqual(self.request_generation(key=first_key).data["state"], "failed")
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)
        self.assertEqual(GenerationRequest.objects.count(), 2)
        self.assertEqual(self.request_generation().status_code, 202)
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 2)

    def test_same_key_different_payload_is_conflict(self):
        key = uuid.uuid4()
        self.request_generation(key=key)
        services.update_document(self.owner, self.document.id, {"text": "改訂版"})
        new_version = self.document.versions.first()
        self.assertEqual(
            self.request_generation(key=key, version=new_version.id).status_code, 409
        )
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    def test_ready_audio_is_reused_and_legacy_cache_is_not_recharged(self):
        first = self.queued()
        generation.work_once()
        self.assertEqual(self.request_generation().status_code, 200)
        self.assertEqual(GenerationJob.objects.count(), 1)
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)
        first.delete()
        self.assertEqual(self.request_generation().status_code, 200)
        self.assertEqual(GenerationJob.objects.get().state, "succeeded")
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    @override_settings(TTS_DAILY_USER_CHARACTERS=1)
    def test_user_character_budget_rejected_without_reserving(self):
        self.assertEqual(self.request_generation().status_code, 429)
        self.assertFalse(GenerationJob.objects.exists())
        self.assertFalse(UserTtsBudget.objects.exists())

    @override_settings(TTS_DAILY_GLOBAL_CHARACTERS=1)
    def test_global_character_budget_rejected(self):
        self.assertEqual(self.request_generation().status_code, 429)

    @override_settings(TTS_DAILY_USER_REQUESTS=1)
    def test_daily_request_budget_and_explicit_failed_retry(self):
        job = self.queued()
        job.state, job.error_code = "failed", "execution_unknown"
        job.save()
        self.assertEqual(self.request_generation().status_code, 429)
        self.assertEqual(self.request_generation(key=job.client_id).status_code, 200)

    @override_settings(TTS_USER_ACTIVE_JOBS=1)
    def test_active_job_capacity_and_reused_job(self):
        self.queued()
        self.assertEqual(self.request_generation().status_code, 200)
        another = services.create_document(
            self.owner, {"title": "別資料", "text": "別の本文"}
        )
        response = self.client.post(
            f"/api/documents/{another.id}/audio-generation/",
            {
                "document_version": str(another.versions.first().id),
                "client_id": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 409)

    def test_lease_expiry_is_terminal_and_stale_worker_cannot_publish(self):
        self.queued()
        claimed = generation.claim_job()
        GenerationJob.objects.filter(pk=claimed.pk).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertEqual(generation.expire_leases(), 1)
        with patch(
            "capture.polly.synthesize", return_value=synthesize("text", "fixture")
        ):
            generation.process_job(claimed)
        claimed.refresh_from_db()
        self.assertEqual(
            (claimed.state, claimed.error_code), ("failed", "execution_unknown")
        )
        self.assertIsNone(claimed.audio_version_id)
        self.assertFalse(generation.work_once())
        self.assertEqual(list(storage.files()), [])

    def test_document_deletion_preserves_budget_receipt_and_marks_job_failed(self):
        job = self.queued()
        count = GlobalTtsBudget.objects.get().characters_reserved
        self.document.delete()
        job.refresh_from_db()
        self.assertIsNone(job.document_version_id)
        self.assertEqual((job.state, job.error_code), ("failed", "parent_deleted"))
        self.assertEqual(GlobalTtsBudget.objects.get().characters_reserved, count)
        self.assertEqual(UserTtsBudget.objects.get().characters_reserved, count)
        response = self.request_generation(key=job.client_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], str(job.id))
        self.assertFalse(generation.work_once())

    def test_deleting_completed_source_keeps_receipt_but_no_dangling_ready_result(self):
        job = self.queued()
        generation.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.document.delete()
        job.refresh_from_db()
        self.assertEqual((job.state, job.error_code), ("failed", "parent_deleted"))
        self.assertIsNone(job.audio_version_id)
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)
        self.assertEqual(self.request_generation(key=job.client_id).status_code, 200)

    def test_deletion_during_remote_work_cannot_publish(self):
        self.queued()
        job = generation.claim_job()
        data = synthesize("text", "fixture")

        def delete_parent(*args):
            self.document.delete()
            return data

        with patch("capture.polly.synthesize", side_effect=delete_parent):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.error_code, "parent_deleted")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertEqual(list(storage.files()), [])

    def test_storage_and_db_failure_cleanup_without_refunding_budget(self):
        self.queued()
        job = generation.claim_job()
        with patch(
            "capture.storage.put_bytes",
            side_effect=OSError("source must never appear in logs"),
        ):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.error_code, "storage_failed")
        self.request_generation()
        job = generation.claim_job()
        with patch(
            "capture.generation.AudioVersion.objects.create",
            side_effect=RuntimeError("private source"),
        ):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.error_code, "internal_error")
        self.assertEqual(list(storage.files()), [])
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 2)

    def test_invalid_or_truncated_audio_is_failed(self):
        self.queued()
        job = generation.claim_job()
        with patch(
            "capture.polly.synthesize", return_value=(b"not audio", "audio/mpeg", "mp3")
        ):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.error_code, "audio_invalid")
        self.request_generation()
        job = generation.claim_job()
        with patch("capture.generation.probe_duration", return_value=570000):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.error_code, "audio_too_long")
        self.assertFalse(AudioVersion.objects.exists())

    def test_worker_remote_operation_is_outside_transaction(self):
        # TestCase itself has a transaction; the worker must add no atomic block.
        self.queued()
        job = generation.claim_job()
        level = len(connection.atomic_blocks)
        payload = synthesize("text", "fixture")

        def verify(*args):
            self.assertEqual(len(connection.atomic_blocks), level)
            return payload

        with patch("capture.polly.synthesize", side_effect=verify):
            generation.process_job(job)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_result_arriving_after_lease_expiry_is_discarded(self):
        self.queued()
        job = generation.claim_job()
        payload = synthesize("text", "fixture")

        def expired_result(*args):
            GenerationJob.objects.filter(pk=job.pk).update(
                lease_expires_at=timezone.now() - timedelta(seconds=1)
            )
            generation.expire_leases()
            return payload

        with patch("capture.polly.synthesize", side_effect=expired_result) as provider:
            generation.process_job(job)
            provider.assert_called_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "execution_unknown")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertEqual(list(storage.files()), [])

    @override_settings(TTS_DAILY_USER_REQUESTS=1)
    def test_utc_day_rollover_adds_new_budget_without_changing_old_reservation(self):
        before = timezone.now().replace(hour=23, minute=59, second=59)
        with patch("capture.generation.timezone.now", return_value=before):
            job = self.queued()
        job.state, job.error_code = "failed", "execution_unknown"
        job.save()
        with patch(
            "capture.generation.timezone.now",
            return_value=before + timedelta(seconds=2),
        ):
            self.assertEqual(self.request_generation().status_code, 202)
            self.assertEqual(
                self.request_generation(key=job.client_id).data["id"], str(job.id)
            )
        self.assertEqual(GlobalTtsBudget.objects.count(), 2)
        self.assertEqual(
            list(
                UserTtsBudget.objects.order_by("day").values_list(
                    "requests_reserved", flat=True
                )
            ),
            [1, 1],
        )

    @override_settings(TTS_GLOBAL_ACTIVE_JOBS=0)
    def test_global_active_queue_capacity_is_bounded(self):
        self.assertEqual(self.request_generation().status_code, 409)
        self.assertFalse(GenerationJob.objects.exists())

    @override_settings(MAX_PRIVATE_BYTES_PER_USER=1)
    def test_worker_enforces_final_storage_capacity(self):
        job = self.queued()
        generation.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "capacity_exceeded")
        self.assertEqual(list(storage.files()), [])
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    def test_disabling_provider_after_enqueue_prevents_remote_call(self):
        job = self.queued()
        with override_settings(LC_E2E_FIXTURE_TTS=False):
            with patch("capture.polly.boto3.client") as provider:
                generation.work_once()
                provider.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "tts_disabled")

    @override_settings(
        LC_E2E_FIXTURE_TTS=False, POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True
    )
    def test_polly_network_failure_is_not_retried_or_requeued(self):
        self.queued()
        with patch("capture.polly.boto3.client") as client:
            client.return_value.synthesize_speech.side_effect = ReadTimeoutError(
                endpoint_url="https://polly.invalid"
            )
            generation.work_once()
            self.assertEqual(client.return_value.synthesize_speech.call_count, 1)
            config = client.call_args.kwargs["config"]
            self.assertEqual(config.retries["total_max_attempts"], 1)
            self.assertEqual((config.connect_timeout, config.read_timeout), (5, 45))
        job = GenerationJob.objects.get()
        self.assertEqual(
            (job.state, job.error_code, job.attempt_count),
            ("failed", "execution_unknown", 1),
        )
        self.assertFalse(generation.work_once())
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    @override_settings(
        LC_E2E_FIXTURE_TTS=False, POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True
    )
    def test_provider_errors_do_not_expose_source_or_exception_text(self):
        job = self.queued()
        with patch("capture.polly.boto3.client") as client:
            client.return_value.synthesize_speech.side_effect = ClientError(
                {
                    "Error": {
                        "Code": "AccessDeniedException",
                        "Message": "PRIVATE SOURCE",
                    }
                },
                "SynthesizeSpeech",
            )
            generation.work_once()
        response = self.client.get(f"/api/audio-generations/{job.id}/")
        self.assertEqual(response.data["error_code"], "provider_rejected")
        self.assertNotIn("PRIVATE SOURCE", str(response.data))

    @override_settings(
        LC_E2E_FIXTURE_TTS=False, POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True
    )
    def test_stream_timeout_is_bounded_by_remaining_wall_clock_deadline(self):
        stream = MagicMock()
        stream.read.side_effect = [b"synthetic-sdk-bytes", b""]
        with patch("capture.polly.boto3.client") as provider:
            provider.return_value.synthesize_speech.return_value = {
                "AudioStream": stream
            }
            with patch("capture.polly.time.monotonic", side_effect=[0, 70, 71, 72]):
                data, _, _ = synthesize("text", "polly")
        self.assertEqual(data, b"synthetic-sdk-bytes")
        self.assertEqual(
            [call.args[0] for call in stream.set_socket_timeout.call_args_list], [10, 8]
        )
        stream.close.assert_called_once()


@override_settings(**FIXTURE)
class GenerationConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.users = [
            get_user_model().objects.create_user(f"budget-{index}", password="test")
            for index in range(2)
        ]
        self.documents = [
            services.create_document(user, {"title": "同時生成", "text": "あ" * 6})
            for user in self.users
        ]

    def concurrently(self, function):
        barrier = Barrier(2)

        def run(index):
            try:
                barrier.wait(timeout=10)
                return function(index)
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(run, range(2)))

    @override_settings(TTS_DAILY_GLOBAL_CHARACTERS=10)
    def test_two_users_cannot_over_reserve_global_budget(self):
        def request(index):
            document = self.documents[index]
            try:
                generation.enqueue(
                    self.users[index],
                    document.id,
                    document.versions.first().id,
                    uuid.uuid4(),
                )
                return "accepted"
            except generation.BudgetExceeded:
                return "limited"

        self.assertEqual(sorted(self.concurrently(request)), ["accepted", "limited"])
        self.assertEqual(GlobalTtsBudget.objects.get().characters_reserved, 6)
        self.assertEqual(GenerationJob.objects.count(), 1)

    def test_duplicate_keys_concurrently_reserve_once(self):
        key = uuid.uuid4()
        document = self.documents[0]
        version_id = document.versions.first().id

        def request(_):
            job, created = generation.enqueue(
                self.users[0], document.id, version_id, key
            )
            return job.id, created

        results = self.concurrently(request)
        self.assertEqual(results[0][0], results[1][0])
        self.assertEqual(sorted(item[1] for item in results), [False, True])
        self.assertEqual(GlobalTtsBudget.objects.get().requests_reserved, 1)

    def test_worker_claim_skip_locked_never_claims_the_same_job(self):
        for index, document in enumerate(self.documents):
            generation.enqueue(
                self.users[index],
                document.id,
                document.versions.first().id,
                uuid.uuid4(),
            )
        jobs = self.concurrently(lambda _: generation.claim_job())
        self.assertNotEqual(jobs[0].id, jobs[1].id)
        self.assertEqual({job.state for job in jobs}, {"running"})

    def test_cli_worker_once_on_real_committed_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            with override_settings(PRIVATE_MEDIA_ROOT=Path(directory)):
                document = self.documents[0]
                job, _ = generation.enqueue(
                    self.users[0],
                    document.id,
                    document.versions.first().id,
                    uuid.uuid4(),
                )
                call_command("audio_worker", once=True)
                job.refresh_from_db()
                self.assertEqual(job.state, "succeeded")
                self.assertEqual(job.audio_version.kind, "fixture")
                document.delete()
