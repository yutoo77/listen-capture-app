"""Operational inventory preserves pending PDF objects as well as audio/memos."""

from datetime import timedelta
import io
import os
from pathlib import Path
import tempfile
import uuid
import wave
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from capture import storage
from capture.models import (
    AudioSegment,
    AudioVersion,
    Document,
    DocumentVersion,
    PdfImport,
)
from capture.narration_models import NarrationJob, NarrationSegment
from capture.storage_inventory import referenced_keys


class PrivateInventoryTests(TestCase):
    def playlist(self):
        document = Document.objects.create(owner=self.owner, title="Private playlist")
        version = DocumentVersion.objects.create(
            document=document, number=1, text="Part"
        )
        output = io.BytesIO()
        with wave.open(output, "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"\0\0" * 1600)
        data = output.getvalue()
        audio = AudioVersion.objects.create(
            document_version=version,
            kind="fixture",
            delivery="playlist",
            storage_key=None,
            size_bytes=len(data),
            duration_ms=100,
        )
        segment = AudioSegment.objects.create(
            audio_version=audio,
            index=0,
            storage_key=storage.put_bytes(data, "wav"),
            size_bytes=len(data),
            frames=1600,
            start_ms=0,
            end_ms=100,
            duration_ms=100,
            start_offset=0,
            end_offset=4,
        )
        return audio, segment

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting = override_settings(
            PRIVATE_STORAGE_BACKEND="local", PRIVATE_MEDIA_ROOT=Path(directory.name)
        )
        setting.enable()
        self.addCleanup(setting.disable)
        self.owner = get_user_model().objects.create_user("inventory-owner")
        self.key = storage.put_bytes(b"%PDF-synthetic-inventory", "pdf")
        self.imported = PdfImport.objects.create(
            owner=self.owner,
            client_id=uuid.uuid4(),
            payload_digest="a" * 64,
            suggested_title="Pending private PDF",
            storage_key=self.key,
            source_size_bytes=1,
            expires_at=timezone.now() + timedelta(days=1),
        )

    def test_old_pending_source_is_protected_and_only_unreferenced_object_deleted(self):
        orphan = storage.put_bytes(b"orphan", "pdf")
        old = (timezone.now() - timedelta(hours=25)).timestamp()
        for key in (self.key, orphan):
            os.utime(storage.path_for(key), (old, old))
        self.assertIn(self.key, referenced_keys())
        output = io.StringIO()
        call_command("cleanup_private_files", delete=True, stdout=output)
        self.assertTrue(storage.path_for(self.key).is_file())
        self.assertFalse(storage.path_for(orphan).exists())
        self.assertIn("orphan_files_older_than_24h=1", output.getvalue())

    def test_reconcile_uses_pdf_source_size_field_and_skips_purged_receipt(self):
        call_command("reconcile_private_sizes", apply=True, stdout=io.StringIO())
        self.imported.refresh_from_db()
        self.assertEqual(
            self.imported.source_size_bytes, len(b"%PDF-synthetic-inventory")
        )
        PdfImport.objects.filter(pk=self.imported.pk).update(
            storage_key=None, source_size_bytes=0
        )
        self.assertNotIn(self.key, referenced_keys())

    def test_storage_outage_stops_cleanup_before_any_delete(self):
        with (
            patch(
                "capture.storage.stat",
                side_effect=storage.StorageUnavailable("synthetic outage"),
            ),
            patch("capture.storage.delete_key") as deleted,
        ):
            with self.assertRaises(storage.StorageUnavailable):
                call_command("cleanup_private_files", delete=True, stdout=io.StringIO())
            deleted.assert_not_called()

    def test_failed_job_successful_partial_remains_protected_for_explicit_retry(self):
        document = Document.objects.create(owner=self.owner, title="Retained partial")
        version = DocumentVersion.objects.create(
            document=document, number=1, text="Part"
        )
        job = NarrationJob.objects.create(
            owner=self.owner,
            document_version=version,
            document_id_snapshot=document.id,
            version_id_snapshot=version.id,
            reading_text="Part",
            provider="fixture",
            state="failed",
            character_count=4,
        )
        key = storage.put_bytes(b"\0\0" * 1600, "pcm")
        NarrationSegment.objects.create(
            job=job,
            index=0,
            start_offset=0,
            end_offset=4,
            state="succeeded",
            storage_key=key,
            size_bytes=3200,
            frames=1600,
            duration_ms=100,
        )
        old = (timezone.now() - timedelta(hours=25)).timestamp()
        os.utime(storage.path_for(key), (old, old))
        self.assertIn(key, referenced_keys())
        call_command("cleanup_private_files", delete=True, stdout=io.StringIO())
        self.assertTrue(storage.path_for(key).is_file())

    def test_playlist_physical_segments_protected_and_aggregate_never_statted(self):
        audio, segment = self.playlist()
        old = (timezone.now() - timedelta(hours=25)).timestamp()
        os.utime(storage.path_for(segment.storage_key), (old, old))
        self.assertIn(segment.storage_key, referenced_keys())
        with patch("capture.storage.stat", wraps=storage.stat) as stat:
            call_command("cleanup_private_files", delete=True, stdout=io.StringIO())
            call_command("reconcile_private_sizes", apply=True, stdout=io.StringIO())
        self.assertTrue(storage.path_for(segment.storage_key).is_file())
        self.assertTrue(all(call.args[0] is not None for call in stat.call_args_list))
        audio.refresh_from_db()
        self.assertIsNone(audio.storage_key)
        self.assertEqual(audio.size_bytes, segment.size_bytes)

    def test_corrupt_published_segment_cannot_rewrite_immutable_size_receipt(self):
        _, segment = self.playlist()
        source = storage.path_for(segment.storage_key)
        source.write_bytes(source.read_bytes()[:-1])
        with self.assertRaisesRegex(CommandError, "metadata is immutable"):
            call_command("reconcile_private_sizes", apply=True, stdout=io.StringIO())
        segment.refresh_from_db()
        self.assertEqual(
            segment.size_bytes, storage.stat(segment.storage_key).size_bytes + 1
        )
