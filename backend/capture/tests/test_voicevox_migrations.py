"""Real PostgreSQL upgrade/backfill and refusal before provenance-loss DDL."""

import re
import uuid

from django.conf import settings
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test import TransactionTestCase, override_settings

from capture import narration, voicevox_provider
from capture.tests.test_narration import FIXTURE


@override_settings(**FIXTURE)
class VoicevoxMigrationTests(TransactionTestCase):
    before = ("capture", "0009_paid_capacity_admission")
    after = ("capture", "0010_voicevox_profiles")

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target])
        return executor.loader.project_state([target]).apps

    def test_old_job_backfill_reuses_original_UUID_and_reverse_refuses_voice_provenance(
        self,
    ):
        self.assertEqual(connection.vendor, "postgresql")
        leaves = MigrationExecutor(connection).loader.graph.leaf_nodes()
        try:
            old = self.migrate(self.before)
            owner = old.get_model(*settings.AUTH_USER_MODEL.split(".")).objects.create(
                username="voice-profile-migration-owner", password="!"
            )
            document = old.get_model("capture", "Document").objects.create(
                owner_id=owner.pk, title="既存の教材"
            )
            version = old.get_model("capture", "DocumentVersion").objects.create(
                document_id=document.pk, number=1, text="原文。"
            )
            legacy = old.get_model("capture", "NarrationJob").objects.create(
                owner_id=owner.pk,
                document_version_id=version.pk,
                document_id_snapshot=document.pk,
                version_id_snapshot=version.pk,
                reading_text=version.text,
                provider="fixture",
                character_count=len(version.text),
            )
            original_key = uuid.uuid4()
            old.get_model("capture", "NarrationRequest").objects.create(
                owner_id=owner.pk,
                client_id=original_key,
                job_id=legacy.pk,
                operation="start",
            )
            audio = old.get_model("capture", "AudioVersion").objects.create(
                document_version_id=version.pk,
                kind="fixture",
                storage_key="synthetic-migration-only.wav",
                duration_ms=1000,
            )
            upgraded = self.migrate(self.after)
            Job = upgraded.get_model("capture", "NarrationJob")
            Audio = upgraded.get_model("capture", "AudioVersion")
            restored = Job.objects.get(pk=legacy.pk)
            self.assertEqual(restored.voice_settings, {})
            self.assertEqual(restored.synthesis_profile, {})
            self.assertEqual(
                restored.profile_hash, voicevox_provider.EMPTY_PROFILE_HASH
            )
            self.assertEqual(Audio.objects.get(pk=audio.pk).synthesis_profile, {})
            # The previous image omits all four new columns. Database defaults
            # must preserve its existing writes during a controlled rollback.
            old_job = old.get_model("capture", "NarrationJob").objects.create(
                owner_id=owner.pk,
                document_version_id=version.pk,
                document_id_snapshot=document.pk,
                version_id_snapshot=version.pk,
                reading_text=version.text,
                provider="windows",
                character_count=len(version.text),
            )
            old_audio = old.get_model("capture", "AudioVersion").objects.create(
                document_version_id=version.pk,
                kind="fixture",
                storage_key="synthetic-old-image-after-upgrade.wav",
                duration_ms=1000,
            )
            inserted = Job.objects.get(pk=old_job.pk)
            self.assertEqual(inserted.voice_settings, {})
            self.assertEqual(inserted.synthesis_profile, {})
            self.assertEqual(
                inserted.profile_hash, voicevox_provider.EMPTY_PROFILE_HASH
            )
            self.assertEqual(Audio.objects.get(pk=old_audio.pk).synthesis_profile, {})
            from django.contrib.auth import get_user_model

            # Current application code needs the additive cancellation column;
            # the assertions above still inspect the exact 0010 schema.
            MigrationExecutor(connection).migrate(leaves)
            owner = get_user_model().objects.get(pk=owner.pk)
            replayed, created = narration.enqueue(
                owner, document.pk, version.pk, original_key, "fixture"
            )
            self.assertFalse(created)
            self.assertEqual(replayed.pk, legacy.pk)
            request_key = uuid.uuid4()
            reused, created = narration.enqueue(
                owner,
                document.pk,
                version.pk,
                request_key,
                "fixture",
            )
            self.assertFalse(created)
            self.assertEqual(reused.pk, legacy.pk)
            repeated, created = narration.enqueue(
                owner,
                document.pk,
                version.pk,
                request_key,
                "fixture",
            )
            self.assertFalse(created)
            self.assertEqual(repeated.pk, legacy.pk)
            profile = {"provider": "voicevox", "credit": "VOICEVOX:合成試験"}
            new_audio = Audio.objects.create(
                document_version_id=version.pk,
                kind="voicevox",
                storage_key="synthetic-profile-migration-only.wav",
                duration_ms=1000,
                synthesis_profile=profile,
            )
            # Isolate 0010's pre-DDL reversal guard from later migrations.
            self.migrate(self.after)
            statements = []

            def observe(execute, sql, params, many, context):
                statements.append(sql)
                return execute(sql, params, many, context)

            with (
                connection.execute_wrapper(observe),
                self.assertRaisesRegex(RuntimeError, "Cannot reverse migration 0010"),
            ):
                self.migrate(self.before)
            self.assertFalse(
                any(
                    re.match(r"\s*(ALTER|DROP|CREATE)\b", sql, re.I)
                    for sql in statements
                )
            )
            self.assertIn(
                self.after, MigrationRecorder(connection).applied_migrations()
            )
            self.assertEqual(
                Audio.objects.get(pk=new_audio.pk).synthesis_profile, profile
            )
            self.assertEqual(
                Job.objects.get(pk=legacy.pk).profile_hash,
                voicevox_provider.EMPTY_PROFILE_HASH,
            )
        finally:
            MigrationExecutor(connection).migrate(leaves)
