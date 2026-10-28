"""Offline backup fault injection; actual PostgreSQL references use recovery-drill."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backup_private import backup_pair, verify_pair


class BackupIntegrityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.media = self.directory / "media"
        self.media.mkdir()
        self.key = "aa/synthetic.wav"
        sound = self.media / self.key
        sound.parent.mkdir()
        sound.write_bytes(b"synthetic-audio")
        self.archive = self.directory / "backup"

    @staticmethod
    def fake_dump(*arguments):
        Path(arguments[arguments.index("--file") + 1]).write_bytes(b"synthetic-dump")

    def test_missing_referenced_file_refuses_before_dump_or_manifest(self):
        with (
            patch("backup_private.referenced_media", return_value={"aa/missing.wav"}),
            patch("backup_private.pg_tool") as pg_tool,
        ):
            with self.assertRaisesRegex(ValueError, "references missing private media"):
                backup_pair("synthetic", self.media, self.archive, quiesced=True)
            pg_tool.assert_not_called()
        self.assertFalse(self.archive.exists())

    def test_s3_configuration_refuses_stale_local_mirror_before_database_access(self):
        with (
            patch.dict(os.environ, {"PRIVATE_STORAGE_BACKEND": "s3"}),
            patch("backup_private.referenced_media") as references,
            patch("backup_private.pg_tool") as pg_tool,
        ):
            with self.assertRaisesRegex(ValueError, "requires local storage"):
                backup_pair("synthetic", self.media, self.archive, quiesced=True)
            references.assert_not_called()
            pg_tool.assert_not_called()
        self.assertFalse(self.archive.exists())

    def test_valid_backup_records_refs_and_manifest_cannot_omit_referenced_file(self):
        with (
            patch("backup_private.referenced_media", return_value={self.key}),
            patch("backup_private.pg_tool", side_effect=self.fake_dump),
        ):
            manifest = backup_pair("synthetic", self.media, self.archive, quiesced=True)
        self.assertEqual(manifest["referenced_media"], [self.key])
        verify_pair(self.archive)
        manifest["media"] = []
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "omits database-referenced"):
            verify_pair(self.archive)

    def test_reference_change_during_copy_never_produces_complete_manifest(self):
        with (
            patch(
                "backup_private.referenced_media",
                side_effect=[{self.key}, {self.key, "bb/new.wav"}],
            ),
            patch("backup_private.pg_tool", side_effect=self.fake_dump),
        ):
            with self.assertRaisesRegex(ValueError, "references changed"):
                backup_pair("synthetic", self.media, self.archive, quiesced=True)
        self.assertFalse((self.archive / "manifest.json").exists())

    def test_profile_bearing_dump_is_verified_as_opaque_bytes_without_rewriting(self):
        # Offline checksum contract only. Actual 0010 SQL/profile/UUID restoration
        # is exercised in recovery-drill against independent PostgreSQL databases.
        dump = (
            b"synthetic-custom-dump\0"
            b'{"synthesis_profile":{"provider":"voicevox","pitch_scale":0.08},'
            b'"profile_hash":"synthetic","client_id":"retained-replay-receipt"}'
        )

        def profile_dump(*arguments):
            Path(arguments[arguments.index("--file") + 1]).write_bytes(dump)

        with (
            patch("backup_private.referenced_media", return_value={self.key}),
            patch("backup_private.pg_tool", side_effect=profile_dump),
        ):
            backup_pair("synthetic", self.media, self.archive, quiesced=True)
        verify_pair(self.archive)
        self.assertEqual((self.archive / "database.dump").read_bytes(), dump)
        (self.archive / "database.dump").write_bytes(
            dump.replace(b'"pitch_scale":0.08', b'"pitch_scale":0.09')
        )
        with self.assertRaisesRegex(ValueError, "Database backup checksum mismatch"):
            verify_pair(self.archive)

    def test_changed_dump_is_rejected_even_if_every_media_file_is_intact(self):
        with (
            patch("backup_private.referenced_media", return_value={self.key}),
            patch("backup_private.pg_tool", side_effect=self.fake_dump),
        ):
            backup_pair("synthetic", self.media, self.archive, quiesced=True)
        original_media = (self.archive / "media" / self.key).read_bytes()
        (self.archive / "database.dump").write_bytes(b"different-incomplete-dump")
        with self.assertRaisesRegex(ValueError, "Database backup checksum mismatch"):
            verify_pair(self.archive)
        self.assertEqual(
            (self.archive / "media" / self.key).read_bytes(), original_media
        )

    def test_missing_quiescence_refuses_before_reading_app_database(self):
        with patch("backup_private.referenced_media") as references:
            with self.assertRaisesRegex(ValueError, "Stop all application writers"):
                backup_pair("synthetic", self.media, self.archive, quiesced=False)
            references.assert_not_called()


if __name__ == "__main__":
    unittest.main()
