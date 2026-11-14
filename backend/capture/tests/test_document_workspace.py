import json
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection, connections
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from capture import services, storage
from capture.models import AudioVersion, Document, MemoSubmission, PdfImport, VoiceMemo
from capture.tests.test_api import wav_bytes


class DocumentWorkspaceSetup:
    def setUp(self):
        super().setUp()
        self.assertEqual(
            connection.vendor, "postgresql", "These tests require actual PostgreSQL"
        )
        cache.clear()
        self.alice = get_user_model().objects.create_user(
            "workspace-alice", password="workspace-password"
        )
        self.bob = get_user_model().objects.create_user(
            "workspace-bob", password="workspace-password"
        )
        self.document = services.create_document(
            self.alice, {"title": "元の資料", "text": "元の本文。\n思考を残します。"}
        )
        self.version = self.document.versions.first()
        self.url = f"/api/documents/{self.document.pk}/"
        self.client = APIClient()
        self.client.force_authenticate(self.alice)


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class DocumentWorkspaceTests(DocumentWorkspaceSetup, TestCase):
    def test_create_rejects_mismatched_workspace_before_parsing_the_body(self):
        count = Document.objects.count()
        for header in [str(self.bob.pk), "", "not-a-user"]:
            with self.subTest(header=header):
                response = self.client.post(
                    "/api/documents/",
                    data="{",
                    content_type="application/json",
                    HTTP_X_WORKSPACE_USER=header,
                )
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.data["code"], "workspace_changed")
        self.assertEqual(Document.objects.count(), count)

    def test_demo_rejects_mismatched_workspace_before_body_or_service(self):
        with patch("capture.views.services.create_demo") as create_demo:
            response = self.client.post(
                "/api/documents/demo/",
                data="{",
                content_type="application/json",
                HTTP_X_WORKSPACE_USER=str(self.bob.pk),
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "workspace_changed")
        create_demo.assert_not_called()

    def test_create_accepts_matching_and_legacy_missing_workspace_headers(self):
        for headers in [{}, {"HTTP_X_WORKSPACE_USER": str(self.alice.pk)}]:
            with self.subTest(headers=headers):
                response = self.client.post(
                    "/api/documents/",
                    {"title": "新しい資料", "text": "資料の本文。"},
                    format="json",
                    **headers,
                )
                self.assertEqual(response.status_code, 201)
                saved = Document.objects.get(pk=response.data["id"])
                self.assertEqual(saved.owner_id, self.alice.pk)
                self.assertEqual(saved.versions.count(), 1)

    def test_demo_keeps_matching_and_legacy_missing_header_compatibility(self):
        with patch(
            "capture.views.services.create_demo", return_value=(self.document, False)
        ) as create_demo:
            for headers in [{}, {"HTTP_X_WORKSPACE_USER": str(self.alice.pk)}]:
                with self.subTest(headers=headers):
                    response = self.client.post(
                        "/api/documents/demo/", {}, format="json", **headers
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.data["id"], str(self.document.pk))
        self.assertEqual(create_demo.call_count, 2)

    def test_other_authenticated_owner_cannot_create_in_the_old_workspace(self):
        self.client.force_authenticate(self.bob)
        count = Document.objects.count()
        for url in ["/api/documents/", "/api/documents/demo/"]:
            with self.subTest(url=url):
                response = self.client.post(
                    url,
                    {"title": "A画面の入力", "text": "Bには保存しません。"},
                    format="json",
                    HTTP_X_WORKSPACE_USER=str(self.alice.pk),
                )
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.data["code"], "workspace_changed")
        self.assertEqual(Document.objects.count(), count)
        self.assertFalse(Document.objects.filter(owner=self.bob).exists())

    def test_workspace_header_does_not_replace_authentication(self):
        anonymous = APIClient()
        for url in ["/api/documents/", "/api/documents/demo/"]:
            with self.subTest(url=url):
                self.assertEqual(
                    anonymous.post(
                        url,
                        {},
                        format="json",
                        HTTP_X_WORKSPACE_USER=str(self.alice.pk),
                    ).status_code,
                    403,
                )
        for url in ["/api/documents/", "/api/memos/", "/api/pdf-imports/"]:
            with self.subTest(url=url):
                self.assertEqual(
                    anonymous.get(
                        url, HTTP_X_WORKSPACE_USER=str(self.alice.pk)
                    ).status_code,
                    403,
                )

    def test_changed_workspace_lists_refuse_other_accounts_payloads(self):
        marker = "Bだけの非公開資料と音声メモ"
        document = services.create_document(self.bob, {"title": marker, "text": marker})
        audio = AudioVersion.objects.create(
            document_version=document.versions.first(),
            kind="demo",
            storage_key=f"{uuid.uuid4().hex}.wav",
            content_type="audio/wav",
            duration_ms=2000,
            size_bytes=100,
        )
        submission = MemoSubmission.objects.create(
            owner=self.bob, client_id=uuid.uuid4(), payload_digest="b" * 64
        )
        VoiceMemo.objects.create(
            submission=submission,
            audio_version=audio,
            position_ms=1234,
            duration_ms=1000,
            text=marker,
            storage_key=f"{uuid.uuid4().hex}.wav",
            content_type="audio/wav",
            size_bytes=100,
        )
        PdfImport.objects.create(
            owner=self.bob,
            client_id=uuid.uuid4(),
            payload_digest="c" * 64,
            suggested_title=marker,
            extracted_text=marker,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        self.client.force_authenticate(self.bob)
        for url in ["/api/documents/", "/api/memos/", "/api/pdf-imports/"]:
            with self.subTest(url=url):
                response = self.client.get(
                    url, HTTP_X_WORKSPACE_USER=str(self.alice.pk)
                )
                self.assertEqual(response.status_code, 409)
                self.assertEqual(set(response.data), {"code", "detail"})
                self.assertEqual(response.data["code"], "workspace_changed")
                self.assertNotIn(
                    marker, json.dumps(response.json(), ensure_ascii=False)
                )
                for headers in [{}, {"HTTP_X_WORKSPACE_USER": str(self.bob.pk)}]:
                    allowed = self.client.get(url, **headers)
                    self.assertEqual(allowed.status_code, 200)
                    self.assertIn(
                        marker, json.dumps(allowed.json(), ensure_ascii=False)
                    )

    def test_pdf_upload_legacy_and_matching_header_contracts_remain_valid(self):
        # Queue admission only; extraction is covered by the existing PDF tests.
        with (
            tempfile.TemporaryDirectory() as directory,
            override_settings(PRIVATE_MEDIA_ROOT=Path(directory)),
        ):
            for headers in [{}, {"HTTP_X_WORKSPACE_USER": str(self.alice.pk)}]:
                response = self.client.post(
                    "/api/pdf-imports/",
                    {
                        "client_id": str(uuid.uuid4()),
                        "file": SimpleUploadedFile("synthetic.pdf", b"%PDF-test-only"),
                    },
                    format="multipart",
                    **headers,
                )
                self.assertEqual(response.status_code, 202)
                self.assertEqual(
                    PdfImport.objects.get(pk=response.data["id"]).owner_id,
                    self.alice.pk,
                )
            with patch("capture.pdf_imports.enqueue") as enqueue:
                response = self.client.post(
                    "/api/pdf-imports/",
                    "invalid multipart",
                    content_type="multipart/form-data; boundary=synthetic",
                    HTTP_X_WORKSPACE_USER=str(self.bob.pk),
                )
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.data["code"], "workspace_changed")
            enqueue.assert_not_called()

    def test_expected_version_is_patch_only_and_post_keeps_strict_input(self):
        response = self.client.post(
            "/api/documents/",
            {
                "title": "新規",
                "text": "新規本文",
                "expected_version": str(self.version.pk),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("expected_version", response.data)
        self.assertEqual(Document.objects.count(), 1)

    def test_title_only_rename_keeps_the_immutable_text_version(self):
        response = self.client.patch(
            self.url,
            {"title": "  新しい題名  ", "expected_version": str(self.version.pk)},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.document.refresh_from_db()
        self.assertEqual(self.document.title, "新しい題名")
        self.assertEqual(self.document.versions.count(), 1)
        self.assertEqual(response.data["current_version"]["id"], str(self.version.pk))
        self.assertEqual(self.document.versions.first().text, self.version.text)

    def test_text_revision_preserves_old_audio_memo_and_private_bytes(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            override_settings(PRIVATE_MEDIA_ROOT=Path(directory)),
        ):
            audio_bytes, memo_bytes = wav_bytes(2), wav_bytes()
            audio = AudioVersion.objects.create(
                document_version=self.version,
                kind="demo",
                storage_key=storage.put_bytes(audio_bytes, "wav"),
                content_type="audio/wav",
                duration_ms=2000,
                size_bytes=len(audio_bytes),
            )
            submission = MemoSubmission.objects.create(
                owner=self.alice, client_id=uuid.uuid4(), payload_digest="a" * 64
            )
            memo = VoiceMemo.objects.create(
                submission=submission,
                audio_version=audio,
                position_ms=1234,
                duration_ms=1000,
                text="元の音声に残した考え",
                storage_key=storage.put_bytes(memo_bytes, "wav"),
                content_type="audio/wav",
                size_bytes=len(memo_bytes),
            )
            response = self.client.patch(
                self.url,
                {
                    "title": "改訂した資料",
                    "text": "新しい本文。\n🌸をそのまま保存します。",
                    "expected_version": str(self.version.pk),
                },
                format="json",
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["current_version"]["number"], 2)
            self.assertEqual(
                response.data["audio_versions"][0]["document_version"], self.version.pk
            )
            memo.refresh_from_db()
            self.assertEqual(memo.audio_version_id, audio.pk)
            self.assertEqual(memo.audio_version.document_version_id, self.version.pk)
            self.assertEqual(memo.position_ms, 1234)
            self.version.refresh_from_db()
            self.assertEqual(self.version.text, "元の本文。\n思考を残します。")
            current = self.document.versions.first()
            self.assertEqual(
                "".join(block.text for block in current.text_blocks.all()), current.text
            )
            for url, expected in [
                (f"/api/audio/{audio.pk}/content/", audio_bytes),
                (f"/api/memos/{memo.pk}/content/", memo_bytes),
            ]:
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(b"".join(response.streaming_content), expected)

    def test_same_text_retry_does_not_create_duplicate_versions(self):
        body = {"text": "改訂する本文", "expected_version": str(self.version.pk)}
        first = self.client.patch(self.url, body, format="json")
        self.assertEqual(first.status_code, 200)
        # A lost ACK cannot turn the stale precondition into an unconditional write.
        replay = self.client.patch(self.url, body, format="json")
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(replay.data["code"], "version_conflict")
        body["expected_version"] = first.data["current_version"]["id"]
        self.assertEqual(
            self.client.patch(self.url, body, format="json").status_code, 200
        )
        self.assertEqual(self.document.versions.count(), 2)
        # Existing clients without the optional precondition remain compatible.
        self.assertEqual(
            self.client.patch(
                self.url, {"text": body["text"]}, format="json"
            ).status_code,
            200,
        )
        self.assertEqual(self.document.versions.count(), 2)

    def test_stale_version_changes_neither_title_text_nor_timestamp(self):
        winner = services.update_document(
            self.alice, self.document.pk, {"title": "先の題名", "text": "先の編集"}
        )
        latest = winner.versions.first()
        before = winner.updated_at
        response = self.client.patch(
            self.url,
            {
                "title": "失われるべきでない題名",
                "text": "古い画面の本文",
                "expected_version": str(self.version.pk),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "version_conflict")
        self.assertEqual(response.data["current_version"], str(latest.pk))
        winner.refresh_from_db()
        self.assertEqual(winner.title, "先の題名")
        self.assertEqual(winner.updated_at, before)
        self.assertEqual(winner.versions.first().text, "先の編集")
        self.assertEqual(winner.versions.count(), 2)

    def test_stale_title_timestamp_refuses_both_title_and_body_atomically(self):
        expected_time = self.document.updated_at.isoformat()
        winner = services.update_document(
            self.alice, self.document.pk, {"title": "別の画面で変更した題名"}
        )
        self.assertEqual(winner.versions.first().pk, self.version.pk)
        before = winner.updated_at
        response = self.client.patch(
            self.url,
            {
                "title": "元の資料",
                "text": "古い画面から変更した本文",
                "expected_version": str(self.version.pk),
                "expected_updated_at": expected_time,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "version_conflict")
        self.assertEqual(response.data["current_version"], str(self.version.pk))
        winner.refresh_from_db()
        self.assertEqual(winner.title, "別の画面で変更した題名")
        self.assertEqual(winner.updated_at, before)
        self.assertEqual(winner.versions.count(), 1)
        self.assertEqual(winner.versions.first().text, self.version.text)

    def test_timestamp_only_guard_rejects_same_payload_replay_without_a_new_version(
        self,
    ):
        body = {
            "title": "時刻で守る題名",
            "expected_updated_at": self.document.updated_at.isoformat(),
        }
        accepted = self.client.patch(self.url, body, format="json")
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.data["current_version"]["id"], str(self.version.pk))
        replay = self.client.patch(self.url, body, format="json")
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(replay.data["code"], "version_conflict")
        self.document.refresh_from_db()
        self.assertEqual(self.document.title, body["title"])
        self.assertEqual(self.document.versions.count(), 1)

    def test_matching_version_and_timestamp_accept_text_revision(self):
        response = self.client.patch(
            self.url,
            {
                "text": "版と時刻を確認した本文",
                "expected_version": str(self.version.pk),
                "expected_updated_at": self.document.updated_at.isoformat(),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["current_version"]["number"], 2)
        self.assertEqual(self.document.versions.count(), 2)

    def test_foreign_or_unknown_expected_version_does_not_reveal_its_existence(self):
        foreign = services.create_document(
            self.bob, {"title": "非公開の資料", "text": "別利用者の本文"}
        ).versions.first()
        responses = []
        for expected in [foreign.pk, uuid.uuid4()]:
            response = self.client.patch(
                self.url,
                {"text": "置き換え", "expected_version": str(expected)},
                format="json",
            )
            self.assertEqual(response.status_code, 409)
            responses.append(response.data)
        self.assertEqual(responses[0], responses[1])
        self.assertEqual(self.document.versions.count(), 1)
        self.assertEqual(self.document.versions.first().text, self.version.text)

    def test_other_owner_cannot_patch_even_with_a_correct_version_or_header(self):
        self.client.force_authenticate(self.bob)
        response = self.client.patch(
            self.url,
            {"text": "越境更新", "expected_version": str(self.version.pk)},
            format="json",
            HTTP_X_WORKSPACE_USER=str(self.bob.pk),
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.document.versions.count(), 1)

    def test_patch_validation_stays_strict(self):
        for body in [
            {"expected_version": "not-a-uuid"},
            {"expected_version": None},
            {"expected_updated_at": "not-a-timestamp"},
            {"expected_updated_at": None},
            {"text": "   "},
            {"text": "NUL\x00"},
            {"title": ""},
            {"owner": self.bob.pk},
        ]:
            with self.subTest(body=body):
                self.assertEqual(
                    self.client.patch(self.url, body, format="json").status_code, 400
                )
        self.assertEqual(self.document.versions.count(), 1)

    def test_precondition_is_not_mutated_or_saved_as_document_data(self):
        values = {
            "title": "別の題名",
            "expected_version": self.version.pk,
            "expected_updated_at": self.document.updated_at,
        }
        original = values.copy()
        document = services.update_document(self.alice, self.document.pk, values)
        self.assertEqual(values, original)
        self.assertEqual(document.title, "別の題名")
        self.assertFalse(hasattr(document, "expected_version"))
        self.assertFalse(hasattr(document, "expected_updated_at"))
        self.assertEqual(document.versions.count(), 1)

    def test_new_guards_do_not_bypass_session_csrf(self):
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.alice)
        token = browser.get("/api/session/").json()["csrfToken"]
        for url, body, method in [
            ("/api/documents/", {"title": "作成", "text": "本文"}, "post"),
            ("/api/documents/demo/", {}, "post"),
            (
                self.url,
                {"text": "改訂", "expected_version": str(self.version.pk)},
                "patch",
            ),
        ]:
            with self.subTest(url=url):
                send = getattr(browser, method)
                kwargs = {
                    "content_type": "application/json",
                    "HTTP_X_WORKSPACE_USER": str(self.alice.pk),
                }
                self.assertEqual(send(url, json.dumps(body), **kwargs).status_code, 403)
                with patch(
                    "capture.views.services.create_demo",
                    return_value=(self.document, False),
                ):
                    accepted = send(
                        url, json.dumps(body), HTTP_X_CSRFTOKEN=token, **kwargs
                    )
                self.assertIn(accepted.status_code, [200, 201])


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentDocumentWorkspaceTests(DocumentWorkspaceSetup, TransactionTestCase):
    def test_competing_title_edits_are_serialized_by_the_timestamp_precondition(self):
        for titles in [("同じ題名", "同じ題名"), ("先の題名", "別の題名")]:
            with self.subTest(titles=titles):
                self.document.refresh_from_db()
                expected_time = self.document.updated_at
                barrier = Barrier(2)

                def update(title):
                    close_old_connections()
                    try:
                        owner = get_user_model().objects.get(pk=self.alice.pk)
                        barrier.wait(timeout=10)
                        try:
                            services.update_document(
                                owner,
                                self.document.pk,
                                {
                                    "title": title,
                                    "expected_version": self.version.pk,
                                    "expected_updated_at": expected_time,
                                },
                            )
                            return 200
                        except services.DocumentVersionConflict:
                            return 409
                    finally:
                        connections.close_all()

                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(update, titles))
                self.assertEqual(sorted(results), [200, 409])
                self.document.refresh_from_db()
                self.assertIn(self.document.title, titles)
                self.assertEqual(self.document.versions.count(), 1)
                self.assertEqual(self.document.versions.first().pk, self.version.pk)

    def test_competing_edits_with_one_expected_version_create_exactly_one_revision(
        self,
    ):
        for texts in [("同じ改訂", "同じ改訂"), ("先の編集", "別の編集")]:
            with self.subTest(texts=texts):
                current = self.document.versions.first()
                count = self.document.versions.count()
                barrier = Barrier(2)

                def update(text):
                    close_old_connections()
                    try:
                        owner = get_user_model().objects.get(pk=self.alice.pk)
                        barrier.wait(timeout=10)
                        try:
                            services.update_document(
                                owner,
                                self.document.pk,
                                {"text": text, "expected_version": current.pk},
                            )
                            return 200
                        except services.DocumentVersionConflict:
                            return 409
                    finally:
                        connections.close_all()

                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(update, texts))
                self.assertEqual(sorted(results), [200, 409])
                self.assertEqual(self.document.versions.count(), count + 1)
                latest = self.document.versions.first()
                self.assertEqual(latest.number, current.number + 1)
                self.assertIn(latest.text, texts)
