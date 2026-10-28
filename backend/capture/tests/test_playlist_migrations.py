import re
import tempfile
from pathlib import Path

from django.conf import settings
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test import TransactionTestCase, override_settings

from capture import narration_provider, storage


class PlaylistMigrationTests(TransactionTestCase):
    """Exercise real schema changes and refusal, not just the reverse function."""

    before = ("capture", "0006_segmented_narration")
    after = ("capture", "0007_audio_playlist")

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target])
        return executor.loader.project_state([target]).apps

    def test_legacy_upgrade_and_safe_reverse_refuses_live_published_assets(self):
        self.assertEqual(connection.vendor, "postgresql")
        leaves = MigrationExecutor(connection).loader.graph.leaf_nodes()
        with (
            tempfile.TemporaryDirectory() as directory,
            override_settings(
                PRIVATE_MEDIA_ROOT=Path(directory), PRIVATE_STORAGE_BACKEND="local"
            ),
        ):
            try:
                old = self.migrate(self.before)
                User = old.get_model(*settings.AUTH_USER_MODEL.split("."))
                owner = User.objects.create(
                    username="playlist-migration-owner", password="!"
                )
                document = old.get_model("capture", "Document").objects.create(
                    owner_id=owner.pk, title="Migration source"
                )
                version = old.get_model("capture", "DocumentVersion").objects.create(
                    document_id=document.pk, number=1, text="あいうえ"
                )
                sound = narration_provider.wave_bytes(b"\x01\x00" * 16000)
                legacy_key = storage.put_bytes(sound, "wav")
                legacy = old.get_model("capture", "AudioVersion").objects.create(
                    document_version_id=version.pk,
                    kind="fixture",
                    storage_key=legacy_key,
                    content_type="audio/wav",
                    size_bytes=len(sound),
                    duration_ms=1000,
                )

                upgraded = self.migrate(self.after)
                AudioVersion = upgraded.get_model("capture", "AudioVersion")
                AudioSegment = upgraded.get_model("capture", "AudioSegment")
                migrated = AudioVersion.objects.get(pk=legacy.pk)
                self.assertEqual(migrated.delivery, "single")
                self.assertEqual(migrated.storage_key, legacy_key)
                self.assertEqual(
                    (migrated.size_bytes, migrated.duration_ms), (len(sound), 1000)
                )
                self.assertEqual(
                    storage.read_bytes(legacy_key, max_bytes=len(sound)), sound
                )

                keys = [storage.put_bytes(sound, "wav") for _ in range(2)]
                with transaction.atomic():
                    playlist = AudioVersion.objects.create(
                        document_version_id=version.pk,
                        kind="fixture",
                        delivery="playlist",
                        storage_key=None,
                        content_type="audio/wav",
                        size_bytes=len(sound) * 2,
                        duration_ms=2000,
                    )
                    for index, key in enumerate(keys):
                        AudioSegment.objects.create(
                            audio_version_id=playlist.pk,
                            index=index,
                            storage_key=key,
                            content_type="audio/wav",
                            size_bytes=len(sound),
                            frames=16000,
                            start_ms=index * 1000,
                            end_ms=(index + 1) * 1000,
                            duration_ms=1000,
                            start_offset=index * 2,
                            end_offset=(index + 1) * 2,
                        )
                original_rows = list(AudioSegment.objects.order_by("index").values())
                statements = []

                def observe_sql(execute, sql, params, many, context):
                    statements.append(sql)
                    return execute(sql, params, many, context)

                with (
                    connection.execute_wrapper(observe_sql),
                    self.assertRaisesRegex(
                        RuntimeError, "Cannot reverse audio playlist migration"
                    ),
                ):
                    self.migrate(self.before)
                # This explicitly proves refusal precedes reverse DDL, rather
                # than relying on PostgreSQL rolling a late NOT NULL error back.
                self.assertFalse(
                    any(
                        re.match(r"\s*(ALTER|DROP|CREATE)\b", sql, re.I)
                        for sql in statements
                    )
                )
                self.assertIn(
                    self.after, MigrationRecorder(connection).applied_migrations()
                )
                self.assertIn(
                    "capture_audiosegment", connection.introspection.table_names()
                )
                self.assertEqual(
                    AudioVersion.objects.get(pk=playlist.pk).delivery, "playlist"
                )
                self.assertEqual(
                    list(AudioSegment.objects.order_by("index").values()), original_rows
                )
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT tgname FROM pg_trigger WHERE tgrelid='capture_audiosegment'::regclass AND NOT tgisinternal"
                    )
                    self.assertEqual(
                        {row[0] for row in cursor.fetchall()},
                        {"lc_audio_segment_immutable", "lc_audio_segment_complete"},
                    )
                for key in keys:
                    self.assertEqual(
                        storage.read_bytes(key, max_bytes=len(sound)), sound
                    )

                # Normal owner-requested deletion is allowed; no reverse code
                # deletes user data or private objects to make rollback pass.
                from capture.models import AudioVersion as CurrentAudioVersion

                # Retain the current deletion signals (including private media
                # cleanup), but select only fields present in schema 0007.
                # Later application fields must not be queried before upgrade.
                CurrentAudioVersion.objects.only(
                    *(field.name for field in AudioVersion._meta.concrete_fields)
                ).get(pk=playlist.pk).delete()
                self.assertFalse(AudioSegment.objects.exists())
                self.assertTrue(all(not storage.path_for(key).exists() for key in keys))
                downgraded = self.migrate(self.before)
                self.assertNotIn(
                    "capture_audiosegment", connection.introspection.table_names()
                )
                preserved = downgraded.get_model("capture", "AudioVersion").objects.get(
                    pk=legacy.pk
                )
                self.assertEqual(preserved.storage_key, legacy_key)
                self.assertEqual(preserved.duration_ms, 1000)
                restored = self.migrate(self.after)
                self.assertEqual(
                    restored.get_model("capture", "AudioVersion")
                    .objects.get(pk=legacy.pk)
                    .delivery,
                    "single",
                )
                self.assertEqual(
                    storage.read_bytes(legacy_key, max_bytes=len(sound)), sound
                )
            finally:
                # Other tests must always receive the latest schema, even when
                # an assertion or a migration itself fails in an earlier phase.
                MigrationExecutor(connection).migrate(leaves)
