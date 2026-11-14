import io
import json
import tempfile
import uuid
import wave
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.test import Client, TestCase, override_settings
from rest_framework.test import APIClient

from capture import services, storage
from capture.models import (
    AudioVersion,
    Document,
    DocumentVersion,
    MemoSubmission,
    PlaybackProgress,
    VoiceMemo,
)


def wav_bytes(seconds=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b"\x00\x00" * (8000 * seconds))
    return output.getvalue()


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ApiTests(TestCase):
    def setUp(self):
        self.assertEqual(
            connection.vendor,
            "postgresql",
            "These integration tests require actual PostgreSQL",
        )
        cache.clear()
        self.directory = tempfile.TemporaryDirectory()
        self.setting = override_settings(PRIVATE_MEDIA_ROOT=Path(self.directory.name))
        self.setting.enable()
        self.addCleanup(self.setting.disable)
        self.addCleanup(self.directory.cleanup)
        self.alice = get_user_model().objects.create_user(
            "alice", password="testing-password-1"
        )
        self.bob = get_user_model().objects.create_user(
            "bob", password="testing-password-2"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.alice)
        self.other = APIClient()
        self.other.force_authenticate(self.bob)
        self.document = services.create_document(
            self.alice, {"title": "日本語", "text": "内容です。"}
        )
        self.version = self.document.versions.first()
        self.audio_key = storage.put_bytes(wav_bytes(2), "wav")
        self.audio = AudioVersion.objects.create(
            document_version=self.version,
            kind="demo",
            storage_key=self.audio_key,
            content_type="audio/wav",
            duration_ms=2000,
        )

    def upload(self, client=None, *, client_id=None, **changes):
        data = {
            "client_id": str(client_id or uuid.uuid4()),
            "audio_version": str(self.audio.id),
            "position_ms": 1000,
            "duration_ms": 1000,
            "text": "疑問です。",
            "audio": SimpleUploadedFile(
                "private-name.wav", wav_bytes(), content_type="audio/wav"
            ),
        }
        data.update(changes)
        return (client or self.client).post("/api/memos/", data, format="multipart")

    @override_settings(SECURE_SSL_REDIRECT=True)
    def test_internal_health_remains_http_ready_while_other_routes_require_https(self):
        anonymous = APIClient()
        response = anonymous.get("/api/health/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"status": "ok"})
        response = anonymous.get("/api/session/")
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response["Location"], "https://testserver/api/session/")
        self.assertEqual(anonymous.get("/api/session/", secure=True).status_code, 200)

    def test_anonymous_cannot_read_any_resources(self):
        anonymous = APIClient()
        for url in [
            "/api/documents/",
            f"/api/documents/{self.document.id}/",
            "/api/memos/",
            f"/api/audio/{self.audio.id}/content/",
        ]:
            with self.subTest(url=url):
                self.assertEqual(anonymous.get(url).status_code, 403)

    def test_document_create_and_owner_lists(self):
        response = self.client.post(
            "/api/documents/", {"title": "新資料", "text": "本文。"}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["current_version"]["number"], 1)
        self.assertEqual(response.data["audio_versions"], [])
        self.assertEqual(Document.objects.get(pk=response.data["id"]).owner, self.alice)
        self.assertEqual(len(self.client.get("/api/documents/").data), 2)
        self.assertEqual(self.other.get("/api/documents/").data, [])

    def test_document_cross_owner_detail_mutations_and_media_hidden(self):
        url = f"/api/documents/{self.document.id}/"
        self.assertEqual(self.other.get(url).status_code, 404)
        self.assertEqual(
            self.other.patch(url, {"title": "attack"}, format="json").status_code, 404
        )
        self.assertEqual(self.other.delete(url).status_code, 404)
        self.assertEqual(
            self.other.get(f"/api/audio/{self.audio.id}/content/").status_code, 404
        )
        self.document.refresh_from_db()
        self.assertEqual(self.document.owner, self.alice)

    def test_no_writable_owner_or_parent_fields(self):
        response = self.client.post(
            "/api/documents/",
            {"title": "x", "text": "y", "owner": self.bob.pk},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.patch(
            f"/api/documents/{self.document.id}/", {"owner": self.bob.pk}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        response = self.upload(owner=self.bob.pk)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(VoiceMemo.objects.count(), 0)

    def test_document_validation(self):
        for body in [
            {"title": "", "text": "ok"},
            {"title": "x", "text": "   "},
            {"title": "x" * 161, "text": "ok"},
            {"title": "x", "text": "y" * 20001},
            {"title": "x", "text": "nul\x00"},
        ]:
            with self.subTest(body=list(body)):
                self.assertEqual(
                    self.client.post(
                        "/api/documents/", body, format="json"
                    ).status_code,
                    400,
                )

    def test_non_object_json_is_rejected_without_creating_or_modifying_data(self):
        # Raw JSON matters here: APIClient treats None as an omitted body.
        for body in (42, True, [{"title": "unexpected"}], [], None, "title"):
            with self.subTest(body=body):
                payload = json.dumps(body)
                for method, url in (
                    (self.client.post, "/api/documents/"),
                    (self.client.patch, f"/api/documents/{self.document.pk}/"),
                    (self.client.put, f"/api/audio/{self.audio.pk}/progress/"),
                ):
                    response = method(
                        url, data=payload, content_type="application/json"
                    )
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("non_field_errors", response.data)
                # Memo uploads deliberately accept multipart/form data only.
                response = self.client.post(
                    "/api/memos/", data=payload, content_type="application/json"
                )
                self.assertEqual(response.status_code, 415)
        self.document.refresh_from_db()
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(self.document.versions.count(), 1)
        self.assertEqual(self.document.versions.first().text, "内容です。")
        self.assertEqual(VoiceMemo.objects.count(), 0)
        self.assertEqual(MemoSubmission.objects.count(), 0)
        self.assertEqual(PlaybackProgress.objects.count(), 0)

    def test_document_list_loads_latest_text_only_with_bounded_queries(self):
        from capture.serializers import DocumentSerializer
        from capture.views import documents_for

        DocumentVersion.objects.create(document=self.document, number=2, text="最新版")
        other = services.create_document(
            self.alice, {"title": "別資料", "text": "別の本文"}
        )
        DocumentVersion.objects.create(document=other, number=2, text="別の最新版")
        # One extra batched query for private PDF provenance; independent of
        # document count, with historical body text still deferred.
        with self.assertNumQueries(5):
            documents = list(documents_for(self.alice))
            data = DocumentSerializer(documents, many=True).data
        self.assertEqual(
            {item["current_version"]["text"] for item in data}, {"最新版", "別の最新版"}
        )
        for document in documents:
            for version in document.versions.all():
                self.assertIn("text", version.get_deferred_fields())

    def test_text_updates_create_versions_and_preserve_memo_anchor(self):
        memo_response = self.upload()
        self.assertEqual(memo_response.status_code, 201)
        response = self.client.patch(
            f"/api/documents/{self.document.id}/",
            {"text": "改訂しました。"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["current_version"]["number"], 2)
        self.assertEqual(
            response.data["audio_versions"][0]["document_version"], self.version.id
        )
        memo = VoiceMemo.objects.get(pk=memo_response.data["id"])
        self.assertEqual(memo.audio_version.document_version_id, self.version.id)
        self.assertEqual(memo.audio_version.document_version.text, "内容です。")
        self.client.patch(
            f"/api/documents/{self.document.id}/",
            {"text": "改訂しました。"},
            format="json",
        )
        self.assertEqual(self.document.versions.count(), 2)

    def test_model_version_update_rejected(self):
        self.version.text = "overwrite"
        with self.assertRaisesMessage(ValueError, "immutable"):
            self.version.save()

    def test_memo_persists_private_file_and_review_text(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        memo = VoiceMemo.objects.get(pk=response.data["id"])
        self.assertEqual(memo.audio_version_id, self.audio.id)
        self.assertEqual(storage.path_for(memo.storage_key).read_bytes(), wav_bytes())
        self.assertNotIn("storage_key", response.data)
        self.assertEqual(len(self.client.get("/api/memos/").data), 1)
        response = self.client.patch(
            f"/api/memos/{memo.id}/", {"text": "追記"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["text"], "追記")

    def test_cross_owner_memo_parent_list_detail_update_delete_media(self):
        self.assertEqual(self.upload(self.other).status_code, 404)
        response = self.upload()
        memo_id = response.data["id"]
        self.assertEqual(self.other.get("/api/memos/").data, [])
        self.assertEqual(
            self.other.get(f"/api/memos/?document={self.document.id}").status_code, 404
        )
        self.assertEqual(self.other.get(f"/api/memos/{memo_id}/").status_code, 404)
        self.assertEqual(
            self.other.patch(
                f"/api/memos/{memo_id}/", {"text": "attack"}, format="json"
            ).status_code,
            404,
        )
        self.assertEqual(self.other.delete(f"/api/memos/{memo_id}/").status_code, 404)
        self.assertEqual(
            self.other.get(f"/api/memos/{memo_id}/content/").status_code, 404
        )

    def test_memo_parent_fields_cannot_change_after_create(self):
        memo = self.upload().data
        for body in [
            {"text": "x", "audio_version": str(uuid.uuid4())},
            {"text": "x", "position_ms": 0},
            {"text": "x", "submission": 1},
            {"text": "x", "owner": self.bob.pk},
        ]:
            self.assertEqual(
                self.client.patch(
                    f"/api/memos/{memo['id']}/", body, format="json"
                ).status_code,
                400,
            )

    def test_exact_retry_is_idempotent_and_payload_change_conflicts(self):
        client_id = uuid.uuid4()
        first = self.upload(client_id=client_id)
        second = self.upload(client_id=client_id)
        self.assertEqual((first.status_code, second.status_code), (201, 200))
        self.assertEqual(first.data["id"], second.data["id"])
        self.assertEqual(VoiceMemo.objects.count(), 1)
        self.assertEqual(
            self.upload(client_id=client_id, text="別の内容").status_code, 409
        )
        self.assertEqual(
            self.upload(client_id=client_id, position_ms=200).status_code, 409
        )
        self.assertEqual(
            self.upload(
                client_id=client_id,
                audio=SimpleUploadedFile(
                    "x.wav", wav_bytes(2), content_type="audio/wav"
                ),
            ).status_code,
            409,
        )
        self.assertEqual(len(list(storage.files())), 2)

    def test_idempotency_is_owner_scoped(self):
        second_document = services.create_document(
            self.bob, {"title": "Bob", "text": "Bob text"}
        )
        second_audio = AudioVersion.objects.create(
            document_version=second_document.versions.first(),
            kind="demo",
            storage_key=storage.put_bytes(wav_bytes(2), "wav"),
            content_type="audio/wav",
            duration_ms=2000,
        )
        client_id = uuid.uuid4()
        self.assertEqual(self.upload(client_id=client_id).status_code, 201)
        self.assertEqual(
            self.upload(
                self.other, client_id=client_id, audio_version=str(second_audio.id)
            ).status_code,
            201,
        )
        self.assertEqual(MemoSubmission.objects.filter(client_id=client_id).count(), 2)

    def test_deleted_memo_cannot_be_recreated_by_retry(self):
        client_id = uuid.uuid4()
        response = self.upload(client_id=client_id)
        memo = VoiceMemo.objects.get(pk=response.data["id"])
        file_path = storage.path_for(memo.storage_key)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(f"/api/memos/{memo.id}/").status_code, 204
            )
        self.assertFalse(file_path.exists())
        self.assertEqual(self.upload(client_id=client_id).status_code, 409)
        self.assertEqual(VoiceMemo.objects.count(), 0)

    def test_document_deletion_cascades_and_removes_files_after_commit(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(f"/api/documents/{self.document.id}/").status_code,
                204,
            )
        self.assertFalse(DocumentVersion.objects.exists())
        self.assertFalse(AudioVersion.objects.exists())
        self.assertFalse(VoiceMemo.objects.exists())
        self.assertEqual(list(storage.files()), [])

    def test_invalid_position_duration_and_uuid(self):
        for changes in [
            {"position_ms": -1},
            {"position_ms": 2001},
            {"duration_ms": 0},
            {"duration_ms": 60001},
            {"audio_version": "invalid"},
            {"client_id": "invalid"},
            {"text": "x" * 10001},
        ]:
            with self.subTest(changes=changes):
                self.assertEqual(self.upload(**changes).status_code, 400)

    def test_invalid_audio_magic_container_and_mime_rejected(self):
        for body, mime in [
            (b"<html>bad</html>", "audio/wav"),
            (wav_bytes(), "text/html"),
            (b"RIFF" + b"\x00" * 4 + b"WAVEinvalid", "audio/wav"),
            (b"", "audio/webm"),
        ]:
            response = self.upload(
                audio=SimpleUploadedFile("x", body, content_type=mime)
            )
            self.assertEqual(response.status_code, 400)
        self.assertEqual(VoiceMemo.objects.count(), 0)

    def test_audio_size_and_actual_duration_bound(self):
        oversized = SimpleUploadedFile(
            "large.wav", b"0" * (12 * 1024 * 1024 + 1), content_type="audio/wav"
        )
        self.assertEqual(self.upload(audio=oversized).status_code, 400)
        too_long = SimpleUploadedFile(
            "long.wav", wav_bytes(65), content_type="audio/wav"
        )
        self.assertEqual(self.upload(audio=too_long).status_code, 400)

    @override_settings(FFPROBE_BINARY="unavailable-ffprobe-command")
    def test_unavailable_validator_returns_retryable_error(self):
        self.assertEqual(self.upload().status_code, 503)
        self.assertEqual(VoiceMemo.objects.count(), 0)

    def test_storage_failure_does_not_commit_receipt(self):
        values = {
            "client_id": uuid.uuid4(),
            "audio_version": self.audio.id,
            "position_ms": 100,
            "duration_ms": 1000,
            "text": "",
            "audio": SimpleUploadedFile("x.wav", wav_bytes(), content_type="audio/wav"),
        }
        with patch(
            "capture.storage.put_bytes", side_effect=OSError("injected disk error")
        ):
            with self.assertRaises(OSError):
                services.create_memo(self.alice, values)
        self.assertFalse(MemoSubmission.objects.exists())
        self.assertFalse(VoiceMemo.objects.exists())

    def test_db_failure_removes_new_file_and_receipt(self):
        values = {
            "client_id": uuid.uuid4(),
            "audio_version": self.audio.id,
            "position_ms": 100,
            "duration_ms": 1000,
            "text": "",
            "audio": SimpleUploadedFile("x.wav", wav_bytes(), content_type="audio/wav"),
        }
        before = set(storage.files())
        with patch(
            "capture.services.VoiceMemo.objects.create",
            side_effect=RuntimeError("injected DB error"),
        ):
            with self.assertRaises(RuntimeError):
                services.create_memo(self.alice, values)
        self.assertEqual(set(storage.files()), before)
        self.assertFalse(MemoSubmission.objects.exists())

    def test_db_constraints_reject_duplicate_versions_and_invalid_duration(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            DocumentVersion.objects.create(
                document=self.document, number=1, text="duplicate"
            )
        receipt = MemoSubmission.objects.create(
            owner=self.alice, client_id=uuid.uuid4(), payload_digest="a" * 64
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            VoiceMemo.objects.create(
                submission=receipt,
                audio_version=self.audio,
                position_ms=0,
                duration_ms=60001,
                storage_key="invalid",
                content_type="audio/wav",
            )

    def test_private_media_range_suffix_head_and_invalid_range(self):
        url = f"/api/audio/{self.audio.id}/content/"
        response = self.client.get(url, HTTP_RANGE="bytes=0-31")
        self.assertEqual(response.status_code, 206)
        self.assertEqual(b"".join(response.streaming_content), wav_bytes(2)[:32])
        self.assertEqual(response["Content-Length"], "32")
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertIn("no-store", response["Cache-Control"])
        response = self.client.get(url, HTTP_RANGE="bytes=-10")
        self.assertEqual(b"".join(response.streaming_content), wav_bytes(2)[-10:])
        response = self.client.head(url, HTTP_RANGE="bytes=0-31")
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"")
        for header in [
            "bytes=999999-",
            "bytes=3-1",
            "bytes=0-1,4-5",
            "bytes=-0",
            "bytes=" + "1" * 5000 + "-",
        ]:
            self.assertEqual(self.client.get(url, HTTP_RANGE=header).status_code, 416)

    def test_arbitrary_private_paths_never_public(self):
        self.assertEqual(self.client.get(f"/media/{self.audio_key}").status_code, 404)
        self.assertEqual(
            self.client.get(f"/private-media/{self.audio_key}").status_code, 404
        )
        with self.assertRaises(ValueError):
            storage.path_for("../../escape")

    def test_malformed_document_query_is_validation_error(self):
        self.assertEqual(self.client.get("/api/memos/?document=nope").status_code, 400)

    @override_settings(MAX_DOCUMENTS_PER_USER=1)
    def test_document_quota_is_scoped_and_lists_are_not_silently_truncated(self):
        self.assertEqual(len(self.client.get("/api/documents/").data), 1)
        self.assertEqual(
            self.client.post(
                "/api/documents/", {"title": "more", "text": "text"}, format="json"
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.post("/api/documents/demo/", {}, format="json").status_code, 409
        )
        self.assertEqual(
            self.other.post(
                "/api/documents/", {"title": "Bob", "text": "text"}, format="json"
            ).status_code,
            201,
        )

    @override_settings(MAX_MEMOS_PER_USER=1)
    def test_memo_quota_preserves_successful_retries(self):
        key = uuid.uuid4()
        self.assertEqual(self.upload(client_id=key).status_code, 201)
        self.assertEqual(self.upload().status_code, 409)
        self.assertEqual(self.upload(client_id=key).status_code, 200)
        self.assertEqual(len(self.client.get("/api/memos/").data), 1)

    @override_settings(MAX_PRIVATE_BYTES_PER_USER=1000)
    def test_private_byte_quota_rejects_without_file_or_receipt(self):
        self.assertEqual(self.upload().status_code, 409)
        self.assertFalse(VoiceMemo.objects.exists())
        self.assertFalse(MemoSubmission.objects.exists())
        self.assertEqual(len(list(storage.files())), 1)

    @override_settings(MAX_VERSIONS_PER_DOCUMENT=1)
    def test_revision_quota_preserves_original(self):
        response = self.client.patch(
            f"/api/documents/{self.document.id}/", {"text": "new"}, format="json"
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.document.versions.count(), 1)

    def test_demo_is_explicit_and_idempotent(self):
        response = self.client.post("/api/documents/demo/", {}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["audio_versions"][0]["kind"], "demo")
        second = self.client.post("/api/documents/demo/", {}, format="json")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(response.data["id"], second.data["id"])
        self.assertEqual(
            self.client.post(
                "/api/documents/demo/", {"owner": self.bob.pk}, format="json"
            ).status_code,
            400,
        )


@override_settings(
    PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
    POLLY_ENABLED=False,
    POLLY_BILLING_APPROVED=False,
    LC_E2E_FIXTURE_TTS=False,
)
class SessionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user(
            "invited", password="test-long-password"
        )
        self.client = Client(enforce_csrf_checks=True)

    def login_request(self, token=None, **changes):
        body = {"username": "invited", "password": "test-long-password"}
        body.update(changes)
        return self.client.post(
            "/api/login/",
            json.dumps(body),
            content_type="application/json",
            **({"HTTP_X_CSRFTOKEN": token} if token else {}),
        )

    def test_logout_204_has_no_body_or_nonzero_content_length(self):
        token = self.client.get("/api/session/").json()["csrfToken"]
        response = self.login_request(token)
        response = self.client.post(
            "/api/logout/", HTTP_X_CSRFTOKEN=response.json()["csrfToken"]
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b"")
        self.assertIn(response.get("Content-Length"), {None, "0"})

    def test_session_anonymous_and_login_logout_enforce_csrf(self):
        response = self.client.get("/api/session/")
        self.assertIsNone(response.json()["user"])
        self.assertFalse(response.json()["ttsAvailable"])
        self.assertEqual(self.login_request().status_code, 403)
        token = response.json()["csrfToken"]
        self.assertEqual(self.login_request(token, password="wrong").status_code, 400)
        response = self.login_request(token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["username"], "invited")
        self.assertNotEqual(token, response.json()["csrfToken"])
        self.assertTrue(self.client.cookies["sessionid"]["httponly"])
        self.assertEqual(self.client.post("/api/logout/").status_code, 403)
        self.assertEqual(
            self.client.post(
                "/api/logout/", HTTP_X_CSRFTOKEN=response.json()["csrfToken"]
            ).status_code,
            204,
        )
        self.assertIsNone(self.client.get("/api/session/").json()["user"])

    def test_session_mutation_requires_csrf_and_cross_origin_rejected(self):
        token = self.client.get("/api/session/").json()["csrfToken"]
        response = self.login_request(token)
        fresh = response.json()["csrfToken"]
        self.assertEqual(
            self.client.post(
                "/api/documents/", {"title": "x", "text": "y"}
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/documents/",
                {"title": "x", "text": "y"},
                HTTP_X_CSRFTOKEN=fresh,
                HTTP_ORIGIN="https://evil.example",
            ).status_code,
            403,
        )
        response = self.client.post(
            "/api/documents/",
            json.dumps({"title": "x", "text": "y"}),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=fresh,
        )
        self.assertEqual(response.status_code, 201)

    @override_settings(LOGIN_RATE_LIMIT=2)
    def test_login_rate_limit(self):
        token = self.client.get("/api/session/").json()["csrfToken"]
        self.assertEqual(self.login_request(token, password="wrong").status_code, 400)
        self.assertEqual(self.login_request(token, password="wrong").status_code, 400)
        self.assertEqual(self.login_request(token, password="wrong").status_code, 429)

    def test_inactive_account_cannot_authenticate(self):
        self.user.is_active = False
        self.user.save()
        token = self.client.get("/api/session/").json()["csrfToken"]
        self.assertEqual(self.login_request(token).status_code, 400)

    def test_login_malformed_json_and_fields(self):
        token = self.client.get("/api/session/").json()["csrfToken"]
        self.assertEqual(
            self.client.post(
                "/api/login/",
                "{",
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
            ).status_code,
            400,
        )
        self.assertEqual(
            self.login_request(token, username=["invalid"]).status_code, 400
        )
