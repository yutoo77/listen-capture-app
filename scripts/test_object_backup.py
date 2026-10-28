"""Object backup fault injection using an in-memory store; never contacts AWS."""

from datetime import datetime, timezone
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from backup_object_store import export_pair
from backup_private import verify_pair


class FakeStore:
    def __init__(self):
        self.data = {"aa/source.pdf": b"%PDF-fixture", "bb/partial.pcm": b"\0\0" * 4}
        self.items = {
            key: SimpleNamespace(
                key=key,
                size_bytes=len(data),
                modified_at=datetime(2026, 10, 18, tzinfo=timezone.utc),
                etag='"v1"',
            )
            for key, data in self.data.items()
        }
        self.opened = 0
        self.changed = False

    def objects(self):
        yield from self.items.values()

    def open_read(self, key, *, length, etag):
        assert length == self.items[key].size_bytes and etag == '"v1"'
        self.opened += 1
        return io.BytesIO(self.data[key])

    def stat(self, key):
        item = self.items[key]
        return (
            SimpleNamespace(**(vars(item) | {"etag": '"v2"'})) if self.changed else item
        )


class ObjectBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name) / "backup"
        self.store = FakeStore()

    @staticmethod
    def dump(*arguments):
        Path(arguments[arguments.index("--file") + 1]).write_bytes(
            b"synthetic DB archive"
        )

    def test_pdf_and_retained_partial_export_to_verified_restore_format(self):
        with (
            patch(
                "backup_object_store.referenced_media",
                return_value=set(self.store.data),
            ),
            patch("backup_object_store.pg_tool", side_effect=self.dump),
        ):
            manifest = export_pair("synthetic", self.store, self.output, quiesced=True)
        self.assertEqual(len(manifest["media"]), 2)
        self.assertEqual(
            verify_pair(self.output)["referenced_media"], sorted(self.store.data)
        )
        for key, data in self.store.data.items():
            self.assertEqual((self.output / "media" / key).read_bytes(), data)

    def test_missing_reference_and_total_limit_refuse_before_dump_or_download(self):
        for references, limit in (({"cc/missing.wav"}, 100), (set(self.store.data), 1)):
            with (
                self.subTest(limit=limit),
                patch("backup_object_store.referenced_media", return_value=references),
                patch("backup_object_store.pg_tool") as dumped,
            ):
                with self.assertRaises(ValueError):
                    export_pair(
                        "synthetic",
                        self.store,
                        self.output,
                        quiesced=True,
                        max_total_bytes=limit,
                    )
                dumped.assert_not_called()
                self.assertEqual(self.store.opened, 0)
                self.assertFalse(self.output.exists())

    def test_etag_change_or_truncated_body_never_writes_complete_manifest(self):
        for failure in ("etag", "truncated"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                self.store = FakeStore()
                if failure == "etag":
                    self.store.changed = True
                else:
                    self.store.data["aa/source.pdf"] = b"short"
                output = Path(folder) / "backup"
                with (
                    patch(
                        "backup_object_store.referenced_media",
                        return_value=set(self.store.data),
                    ),
                    patch("backup_object_store.pg_tool", side_effect=self.dump),
                ):
                    with self.assertRaises(ValueError):
                        export_pair("synthetic", self.store, output, quiesced=True)
                self.assertFalse((output / "manifest.json").exists())

    def test_reference_change_never_writes_complete_manifest(self):
        with (
            patch(
                "backup_object_store.referenced_media",
                side_effect=[set(self.store.data), set()],
            ),
            patch("backup_object_store.pg_tool", side_effect=self.dump),
        ):
            with self.assertRaises(ValueError):
                export_pair("synthetic", self.store, self.output, quiesced=True)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_missing_quiescence_refuses_before_database_or_store_access(self):
        with patch("backup_object_store.referenced_media") as references:
            with self.assertRaises(ValueError):
                export_pair("synthetic", self.store, self.output, quiesced=False)
            references.assert_not_called()
        self.assertEqual(self.store.opened, 0)


if __name__ == "__main__":
    unittest.main()
