"""Cooperative cancellation with real PostgreSQL and offline PCM providers."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from capture import narration, narration_provider, services, storage
from capture.models import AudioVersion, GlobalTtsBudget, TtsCapacityReservation
from capture.tests.test_narration import FIXTURE, PCM, NarrationSetup


@override_settings(**FIXTURE)
class NarrationCancellationTests(NarrationSetup, TransactionTestCase):
    def cancel(self, job, **headers):
        return self.client.post(
            f"/api/narrations/{job.pk}/cancel/", {}, format="json", **headers
        )

    def test_queued_cancel_is_idempotent_and_start_UUID_keeps_its_receipt(self):
        job = self.queued()
        receipt = job.requests.get()
        budget = GlobalTtsBudget.objects.get().characters_reserved
        first = self.cancel(job)
        second = self.cancel(job)
        self.assertEqual([first.status_code, second.status_code], [200, 200])
        self.assertEqual(first.data["state"], "failed")
        self.assertEqual(first.data["error_code"], "user_cancelled")
        self.assertIsNotNone(first.data["cancel_requested_at"])
        self.assertEqual(
            first.data["cancel_requested_at"], second.data["cancel_requested_at"]
        )
        with patch("capture.narration_provider.synthesize") as synth:
            self.assertFalse(narration.work_once())
        synth.assert_not_called()
        self.assertEqual(self.start(receipt.client_id).data["id"], str(job.pk))
        self.assertEqual(GlobalTtsBudget.objects.get().characters_reserved, budget)
        self.assertEqual(job.requests.count(), 1)
        self.assertFalse(AudioVersion.objects.exists())

    def test_cancel_requires_owner_session_csrf_and_unchanged_workspace(self):
        job = self.queued()
        self.client.force_authenticate(self.other)
        self.assertEqual(self.cancel(job).status_code, 404)
        self.client.force_authenticate(None)
        self.assertEqual(self.cancel(job).status_code, 403)
        self.client.force_authenticate(self.owner)
        self.assertEqual(
            self.cancel(job, HTTP_X_WORKSPACE_USER=str(self.other.pk)).status_code,
            409,
        )
        self.assertEqual(
            self.client.post(
                f"/api/narrations/{job.pk}/cancel/",
                {"owner": self.other.pk},
                format="json",
            ).status_code,
            400,
        )
        browser = APIClient(enforce_csrf_checks=True)
        browser.force_login(self.owner)
        url = f"/api/narrations/{job.pk}/cancel/"
        self.assertEqual(browser.post(url, {}, format="json").status_code, 403)
        job.refresh_from_db()
        self.assertIsNone(job.cancel_requested_at)
        token = browser.get("/api/session/").json()["csrfToken"]
        self.assertEqual(
            browser.post(url, {}, format="json", HTTP_X_CSRFTOKEN=token).status_code,
            200,
        )

    @override_settings(POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True)
    def test_queued_paid_cancel_releases_only_its_unused_reservation(self):
        response = self.start(provider="polly")
        self.assertEqual(response.status_code, 202, response.data)
        job = narration.NarrationJob.objects.get(pk=response.data["id"])
        self.assertTrue(TtsCapacityReservation.objects.filter(job_id=job.pk).exists())
        self.cancel(job)
        self.assertFalse(TtsCapacityReservation.objects.filter(job_id=job.pk).exists())

    @override_settings(
        POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True, TTS_USER_ACTIVE_JOBS=1
    )
    def test_inflight_cancel_keeps_slot_and_PCM_then_explicit_retry_reuses_it(self):
        response = self.start(provider="polly")
        self.assertEqual(response.status_code, 202, response.data)
        job = narration.NarrationJob.objects.get(pk=response.data["id"])
        original_segment_count = job.segments.count()
        second = services.create_document(
            self.owner, {"title": "次の資料", "text": "次の本文。"}
        )

        def cancel_during_call(*args):
            result = self.cancel(job)
            self.assertEqual(result.data["state"], "running")
            self.assertIsNotNone(result.data["cancel_requested_at"])
            self.assertEqual(self.retry(job).status_code, 200)
            job.refresh_from_db()
            self.assertIsNotNone(job.lease_token)
            self.assertTrue(
                TtsCapacityReservation.objects.filter(job_id=job.pk).exists()
            )
            with self.assertRaises(services.Conflict):
                narration.enqueue(
                    self.owner,
                    second.pk,
                    second.versions.first().pk,
                    uuid.uuid4(),
                    "fixture",
                )
            return PCM

        with patch(
            "capture.narration_provider.synthesize", side_effect=cancel_during_call
        ) as synth:
            narration.work_once()
        synth.assert_called_once()
        job.refresh_from_db()
        self.assertEqual((job.state, job.error_code), ("failed", "user_cancelled"))
        partial = job.segments.first()
        self.assertEqual(partial.state, "succeeded")
        self.assertEqual(
            storage.read_bytes(partial.storage_key, max_bytes=len(PCM)), PCM
        )
        self.assertFalse(AudioVersion.objects.exists())
        self.assertFalse(TtsCapacityReservation.objects.filter(job_id=job.pk).exists())
        self.assertEqual(self.retry(job).status_code, 202)
        job.refresh_from_db()
        self.assertIsNone(job.cancel_requested_at)
        with patch("capture.narration_provider.synthesize", return_value=PCM) as synth:
            narration.work_once()
        self.assertEqual(synth.call_count, original_segment_count - 1)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_cancel_before_provider_does_not_start_a_call(self):
        job = self.queued()
        claimed = narration.claim_job()
        self.cancel(job)
        with patch("capture.narration_provider.synthesize") as synth:
            narration.process_job(claimed)
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "user_cancelled")
        self.assertTrue(all(s.state == "pending" for s in job.segments.all()))

    def test_cancel_during_unknown_call_keeps_unknown_and_needs_retry_ack(self):
        job = self.queued()

        def unknown(*args):
            self.cancel(job)
            raise narration_provider.ProviderFailure("execution_unknown")

        with patch("capture.narration_provider.synthesize", side_effect=unknown):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "user_cancelled")
        self.assertEqual(job.segments.first().state, "unknown")
        self.assertEqual(self.retry(job).status_code, 409)
        self.assertEqual(self.retry(job, acknowledge_unknown=True).status_code, 202)

    def test_expired_cancelled_lease_fences_old_worker(self):
        job = self.queued()
        claimed = narration.claim_job()
        self.cancel(job)
        narration.NarrationJob.objects.filter(pk=job.pk).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        narration.expire_leases()
        with patch("capture.narration_provider.synthesize") as synth:
            narration.process_job(claimed)
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual((job.state, job.error_code), ("failed", "user_cancelled"))

    def test_cancel_during_encoding_never_publishes_single_or_playlist(self):
        job = self.queued()
        for maximum in (narration.SINGLE_MAX_FRAMES, 1):
            with self.subTest(single_max_frames=maximum):
                if AudioVersion.objects.exists():
                    self.fail("A cancelled job must not publish audio")
                original_encode = narration.encode

                def cancel_during_encoding(*args):
                    self.cancel(job)
                    return original_encode(*args)

                with (
                    patch("capture.narration.SINGLE_MAX_FRAMES", maximum),
                    patch("capture.narration_provider.synthesize", return_value=PCM),
                    patch(
                        "capture.narration.encode", side_effect=cancel_during_encoding
                    ),
                ):
                    narration.work_once()
                job.refresh_from_db()
                self.assertEqual(job.error_code, "user_cancelled")
                self.assertEqual(
                    job.segments.filter(state="succeeded").count(), job.segments.count()
                )
                self.assertFalse(AudioVersion.objects.exists())
                self.assertEqual(len(list(storage.objects())), job.segments.count())
                # Reuse the same job for the second branch, without provider calls.
                if maximum != 1:
                    self.assertEqual(self.retry(job).status_code, 202)

    def test_cancel_after_success_preserves_audio_and_references(self):
        job = self.queued()
        with patch("capture.narration_provider.synthesize", return_value=PCM):
            narration.work_once()
        job.refresh_from_db()
        audio_id = job.audio_version_id
        before = list(storage.objects())
        result = self.cancel(job)
        self.assertEqual(result.data["state"], "succeeded")
        self.assertIsNone(result.data["cancel_requested_at"])
        job.refresh_from_db()
        self.assertEqual(job.audio_version_id, audio_id)
        self.assertEqual(list(storage.objects()), before)

    def test_claim_and_cancel_race_never_generates_after_acknowledgement(self):
        job = self.queued()
        barrier = Barrier(2)

        def race(action):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                if action == "claim":
                    return narration.claim_job()
                owner = get_user_model().objects.get(pk=self.owner.pk)
                return narration.cancel(owner, job.pk)
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            claimed, _ = list(pool.map(race, ["claim", "cancel"]))
        with patch("capture.narration_provider.synthesize") as synth:
            if claimed is not None:
                narration.process_job(claimed)
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "user_cancelled")
