import io
import os
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import MagicMock, patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, connections
from django.test import TestCase, TransactionTestCase, override_settings

from capture import services, storage
from capture.generation import work_once
from capture.models import AudioVersion, MemoSubmission, VoiceMemo
from capture.polly import generate_audio
from capture.tests.test_api import wav_bytes


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ServiceTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.setting = override_settings(PRIVATE_MEDIA_ROOT=Path(self.directory.name))
        self.setting.enable()
        self.addCleanup(self.setting.disable)
        self.addCleanup(self.directory.cleanup)
        self.user = get_user_model().objects.create_user(
            "owner", password="testing-password"
        )
        self.document = services.create_document(
            self.user, {"title": "読書", "text": "短い文章。"}
        )
        self.version = self.document.versions.first()

    @patch("capture.polly.boto3.client")
    def test_polly_disabled_by_default_makes_no_network_request(self, client):
        with self.assertRaisesMessage(RuntimeError, "POLLY_ENABLED"):
            generate_audio(self.version)
        client.assert_not_called()

    @override_settings(
        POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True, LC_E2E_FIXTURE_TTS=False
    )
    @patch("capture.polly.boto3.client")
    def test_polly_adapter_mocked_and_file_version_persisted(self, client):
        sample = (settings.BASE_DIR / "demo" / "sample.mp3").read_bytes()
        stream = MagicMock(wraps=io.BytesIO(sample))
        client.return_value.synthesize_speech.return_value = {"AudioStream": stream}
        job = generate_audio(self.version)
        client.assert_not_called()
        work_once()
        job.refresh_from_db()
        audio = job.audio_version
        self.assertEqual(audio.kind, "polly")
        self.assertEqual(audio.document_version_id, self.version.id)
        self.assertEqual(storage.path_for(audio.storage_key).read_bytes(), sample)
        self.assertGreater(audio.duration_ms, 0)
        client.return_value.synthesize_speech.assert_called_once_with(
            Text="短い文章。",
            TextType="text",
            OutputFormat="mp3",
            VoiceId="Mizuki",
            LanguageCode="ja-JP",
            Engine="standard",
        )
        stream.close.assert_called_once()

    def test_polly_management_command_requires_explicit_cost_confirmation(self):
        with self.assertRaisesMessage(CommandError, "confirm-billable"):
            call_command("generate_audio", str(self.version.id))

    def test_private_cleanup_reports_missing_and_ignores_recent_or_referenced_files(
        self,
    ):
        referenced = storage.put_bytes(wav_bytes(), "wav")
        audio = AudioVersion.objects.create(
            document_version=self.version,
            kind="demo",
            storage_key=referenced,
            content_type="audio/wav",
            duration_ms=1000,
        )
        orphan = storage.put_bytes(wav_bytes(), "wav")
        recent = storage.put_bytes(wav_bytes(), "wav")
        yesterday = time.time() - 60 * 60 * 25
        for key in [referenced, orphan]:
            os.utime(storage.path_for(key), (yesterday, yesterday))
        output = io.StringIO()
        call_command("cleanup_private_files", stdout=output)
        self.assertIn(
            "orphan_files_older_than_24h=1 deleted=False missing_referenced_files=0",
            output.getvalue(),
        )
        self.assertTrue(storage.path_for(orphan).exists())
        call_command("cleanup_private_files", delete=True, stdout=io.StringIO())
        self.assertFalse(storage.path_for(orphan).exists())
        self.assertTrue(storage.path_for(referenced).exists())
        self.assertTrue(storage.path_for(recent).exists())
        storage.path_for(audio.storage_key).unlink()
        output = io.StringIO()
        call_command("cleanup_private_files", stdout=output)
        self.assertIn("missing_referenced_files=1", output.getvalue())


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentSubmissionTests(TransactionTestCase):
    """Real transactions on independent PostgreSQL connections, not a mock race."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.setting = override_settings(PRIVATE_MEDIA_ROOT=Path(self.directory.name))
        self.setting.enable()
        self.addCleanup(self.setting.disable)
        self.addCleanup(self.directory.cleanup)
        self.user = get_user_model().objects.create_user(
            "concurrent", password="testing-password"
        )
        document = services.create_document(
            self.user, {"title": "同時送信", "text": "文章。"}
        )
        self.audio = AudioVersion.objects.create(
            document_version=document.versions.first(),
            kind="demo",
            storage_key=storage.put_bytes(wav_bytes(2), "wav"),
            content_type="audio/wav",
            duration_ms=2000,
        )

    def test_simultaneous_retries_create_one_memo_and_one_file(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        barrier = Barrier(2)
        client_id = uuid.uuid4()

        def submit():
            close_old_connections()
            try:
                owner = get_user_model().objects.get(pk=self.user.pk)
                values = {
                    "client_id": client_id,
                    "audio_version": self.audio.id,
                    "position_ms": 100,
                    "duration_ms": 1000,
                    "text": "",
                    "audio": SimpleUploadedFile(
                        "x.wav", wav_bytes(), content_type="audio/wav"
                    ),
                }
                barrier.wait(timeout=10)
                memo, created = services.create_memo(owner, values)
                return memo.pk, created
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: submit(), range(2)))
        self.assertEqual(results[0][0], results[1][0])
        self.assertEqual(sorted(item[1] for item in results), [False, True])
        self.assertEqual(VoiceMemo.objects.count(), 1)
        self.assertEqual(MemoSubmission.objects.count(), 1)
        self.assertEqual(len(list(storage.files())), 2)
