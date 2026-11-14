import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError, close_old_connections, connections, transaction
from django.test import Client, TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from capture import progress, services
from capture.models import AudioVersion, PlaybackProgress


class ProgressSetup:
    def setUp(self):
        super().setUp()
        cache.clear()
        self.owner = get_user_model().objects.create_user(
            "progress-owner", password="progress-password"
        )
        self.document = services.create_document(
            self.owner, {"title": "再開", "text": "再生位置の保存。"}
        )
        self.audio = AudioVersion.objects.create(
            document_version=self.document.versions.first(),
            kind="fixture",
            storage_key=f"{uuid.uuid4().hex}.wav",
            content_type="audio/wav",
            duration_ms=20000,
        )
        self.url = f"/api/audio/{self.audio.id}/progress/"
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def payload(self, position=10000, revision=0, client_id=None):
        return {
            "position_ms": position,
            "revision": revision,
            "client_id": str(client_id or uuid.uuid4()),
        }


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ProgressApiTests(ProgressSetup, TestCase):
    def test_get_does_not_create_progress_and_valid_save_survives_new_session(self):
        initial = self.client.get(self.url)
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(
            initial.json(),
            {
                "audio_version": str(self.audio.id),
                "position_ms": 0,
                "revision": 0,
                "updated_at": None,
            },
        )
        self.assertEqual(PlaybackProgress.objects.count(), 0)
        saved = self.client.put(self.url, self.payload(), format="json")
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["position_ms"], 10000)
        self.assertEqual(saved.json()["revision"], 1)
        self.assertIsNotNone(saved.json()["updated_at"])
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_login(self.owner)
        self.assertEqual(self.client.get(self.url).json(), saved.json())
        self.assertEqual(saved.headers["Cache-Control"], "private, no-store")

    def test_stale_device_cannot_rewind_or_advance_current_progress(self):
        saved = self.client.put(self.url, self.payload(), format="json").json()
        for position in [1000, 19000]:
            with self.subTest(position=position):
                conflict = self.client.put(
                    self.url, self.payload(position), format="json"
                )
                self.assertEqual(conflict.status_code, 409)
                self.assertEqual(conflict.json()["code"], "progress_conflict")
                self.assertEqual(conflict.json()["progress"], saved)
        self.assertEqual(self.client.get(self.url).json(), saved)

    def test_intentional_seek_backward_requires_current_revision(self):
        self.client.put(self.url, self.payload(), format="json")
        saved = self.client.put(self.url, self.payload(2000, revision=1), format="json")
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["position_ms"], 2000)
        self.assertEqual(saved.json()["revision"], 2)

    def test_lost_response_retry_is_idempotent_and_reused_key_cannot_change_payload(
        self,
    ):
        payload = self.payload()
        saved = self.client.put(self.url, payload, format="json").json()
        retry = self.client.put(self.url, payload, format="json")
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json(), saved)
        changed = {**payload, "position_ms": 1000, "revision": 1}
        self.assertEqual(
            self.client.put(self.url, changed, format="json").status_code, 409
        )
        self.client.put(self.url, self.payload(12000, revision=1), format="json")
        old_retry = self.client.put(self.url, payload, format="json")
        self.assertEqual(old_retry.status_code, 409)
        self.assertEqual(old_retry.json()["progress"]["position_ms"], 12000)
        self.assertEqual(PlaybackProgress.objects.get().revision, 2)

    def test_audio_versions_have_independent_resume_points(self):
        self.client.put(self.url, self.payload(), format="json")
        second_audio = AudioVersion.objects.create(
            document_version=self.audio.document_version,
            kind="fixture",
            storage_key=f"{uuid.uuid4().hex}.wav",
            duration_ms=15000,
        )
        second_url = f"/api/audio/{second_audio.id}/progress/"
        self.assertEqual(self.client.get(second_url).json()["revision"], 0)
        self.client.put(second_url, self.payload(3000), format="json")
        self.assertEqual(self.client.get(self.url).json()["position_ms"], 10000)
        self.assertEqual(self.client.get(second_url).json()["position_ms"], 3000)

    def test_bounds_and_strict_payload_validation_do_not_change_saved_position(self):
        saved = self.client.put(self.url, self.payload(), format="json").json()
        for changes in [
            {"position_ms": -1},
            {"position_ms": 20001},
            {"position_ms": 1.5},
            {"position_ms": True},
            {"revision": -1},
            {"revision": 9007199254740991},
            {"client_id": "invalid"},
            {"owner": self.owner.pk},
            {"updated_at": "2099-01-01T00:00:00Z"},
        ]:
            with self.subTest(changes=changes):
                response = self.client.put(
                    self.url, {**self.payload(revision=1), **changes}, format="json"
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get(self.url).json(), saved)
        for position in [0, self.audio.duration_ms]:
            revision = self.client.get(self.url).json()["revision"]
            self.assertEqual(
                self.client.put(
                    self.url, self.payload(position, revision), format="json"
                ).status_code,
                200,
            )

    def test_foreign_and_unknown_audio_have_identical_responses_and_no_progress_leak(
        self,
    ):
        self.client.put(self.url, self.payload(), format="json")
        other = get_user_model().objects.create_user("other-progress")
        self.client.force_authenticate(other)
        unknown_url = f"/api/audio/{uuid.uuid4()}/progress/"
        for method in ["get", "put"]:
            kwargs = (
                {"data": self.payload(), "format": "json"} if method == "put" else {}
            )
            foreign = getattr(self.client, method)(self.url, **kwargs)
            unknown = getattr(self.client, method)(unknown_url, **kwargs)
            self.assertEqual(foreign.status_code, 404)
            self.assertEqual(foreign.json(), unknown.json())
        self.assertEqual(PlaybackProgress.objects.get().position_ms, 10000)

    def test_session_mutation_requires_csrf_and_rejects_cross_origin(self):
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.owner)
        token = browser.get("/api/session/").json()["csrfToken"]
        payload = json.dumps(self.payload())
        self.assertEqual(
            browser.put(self.url, payload, content_type="application/json").status_code,
            403,
        )
        self.assertEqual(
            browser.put(
                self.url,
                payload,
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
                HTTP_ORIGIN="https://untrusted.example",
            ).status_code,
            403,
        )
        self.assertEqual(
            browser.put(
                self.url,
                payload,
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
            ).status_code,
            200,
        )

    def test_deleted_source_cascades_progress_and_cannot_be_recreated_by_retry(self):
        payload = self.payload()
        self.client.put(self.url, payload, format="json")
        self.document.delete()
        self.assertFalse(PlaybackProgress.objects.exists())
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(
            self.client.put(self.url, payload, format="json").status_code, 404
        )

    def test_database_enforces_positive_revision_nonnegative_position_and_unique_audio(
        self,
    ):
        for changes in [
            {"revision": 0},
            {"revision": 9007199254740992},
            {"position_ms": -1},
        ]:
            with self.subTest(changes=changes), self.assertRaises(IntegrityError):
                with transaction.atomic():
                    PlaybackProgress.objects.create(
                        **{
                            "audio_version": self.audio,
                            "position_ms": 0,
                            "revision": 1,
                            "last_client_id": uuid.uuid4(),
                            **changes,
                        }
                    )
        self.client.put(self.url, self.payload(), format="json")
        with self.assertRaises(IntegrityError), transaction.atomic():
            PlaybackProgress.objects.create(
                audio_version=self.audio,
                position_ms=0,
                revision=1,
                last_client_id=uuid.uuid4(),
            )

    def test_failure_after_database_write_rolls_back_and_same_request_can_retry(self):
        for initial_position in [None, 5000]:
            with self.subTest(initial_position=initial_position):
                PlaybackProgress.objects.all().delete()
                revision = 0
                if initial_position is not None:
                    self.client.put(
                        self.url, self.payload(initial_position), format="json"
                    )
                    revision = 1
                payload = self.payload(10000, revision)
                values = {**payload, "client_id": uuid.UUID(payload["client_id"])}
                # Failure happens AFTER save, before the transaction commits.
                with patch("capture.progress.snapshot", side_effect=RuntimeError):
                    with self.assertRaises(RuntimeError):
                        progress.update(self.owner, self.audio.id, values)
                if initial_position is None:
                    self.assertFalse(PlaybackProgress.objects.exists())
                else:
                    row = PlaybackProgress.objects.get()
                    self.assertEqual(row.position_ms, initial_position)
                    self.assertEqual(row.revision, revision)
                retried = self.client.put(self.url, payload, format="json")
                self.assertEqual(retried.status_code, 200)
                self.assertEqual(retried.json()["revision"], revision + 1)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentProgressTests(ProgressSetup, TransactionTestCase):
    """Use independent real PostgreSQL connections for the absent-row race."""

    def race(self, payloads):
        barrier = Barrier(2)

        def submit(payload):
            close_old_connections()
            try:
                owner = get_user_model().objects.get(pk=self.owner.pk)
                values = {**payload, "client_id": uuid.UUID(payload["client_id"])}
                barrier.wait(timeout=10)
                try:
                    return 200, progress.update(owner, self.audio.id, values)
                except progress.ProgressConflict as exc:
                    return 409, exc.progress
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(submit, payloads))

    def test_simultaneous_first_writes_accept_exactly_one_revision(self):
        results = self.race([self.payload(5000), self.payload(15000)])
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(PlaybackProgress.objects.count(), 1)
        self.assertEqual(PlaybackProgress.objects.get().revision, 1)

    def test_simultaneous_identical_retries_return_same_saved_revision(self):
        payload = self.payload()
        results = self.race([payload, payload])
        self.assertEqual([status for status, _ in results], [200, 200])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(PlaybackProgress.objects.get().revision, 1)

    def test_simultaneous_current_revision_updates_cannot_lose_a_seek(self):
        self.client.put(self.url, self.payload(), format="json")
        results = self.race([self.payload(1000, 1), self.payload(17000, 1)])
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(results[0][1], results[1][1])
        self.assertEqual(PlaybackProgress.objects.get().revision, 2)
