from django.db import migrations, models


PROFILE_GUARDS = """
CREATE FUNCTION lc_immutable_synthesis_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'capture_narrationjob' THEN
    IF NEW.voice_settings IS DISTINCT FROM OLD.voice_settings
       OR NEW.synthesis_profile IS DISTINCT FROM OLD.synthesis_profile
       OR NEW.profile_hash IS DISTINCT FROM OLD.profile_hash THEN
      RAISE EXCEPTION 'Narration synthesis profile is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.synthesis_profile IS DISTINCT FROM OLD.synthesis_profile THEN
    RAISE EXCEPTION 'Audio synthesis profile is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lc_narration_profile_immutable BEFORE UPDATE ON capture_narrationjob
FOR EACH ROW EXECUTE FUNCTION lc_immutable_synthesis_profile();
CREATE TRIGGER lc_audio_profile_immutable BEFORE UPDATE ON capture_audioversion
FOR EACH ROW EXECUTE FUNCTION lc_immutable_synthesis_profile();
"""

REVERSE_GUARDS = """
DROP TRIGGER lc_narration_profile_immutable ON capture_narrationjob;
DROP TRIGGER lc_audio_profile_immutable ON capture_audioversion;
DROP FUNCTION lc_immutable_synthesis_profile();
"""


def refuse_profile_loss(apps, schema_editor):
    alias = schema_editor.connection.alias
    for model in ("NarrationJob", "AudioVersion"):
        if (
            apps.get_model("capture", model)
            .objects.using(alias)
            .exclude(synthesis_profile={})
            .exists()
        ):
            raise RuntimeError(
                "Cannot reverse migration 0010 with voice synthesis provenance"
            )


class Migration(migrations.Migration):
    dependencies = [("capture", "0009_paid_capacity_admission")]

    operations = [
        migrations.AddField(
            "narrationjob",
            "voice_settings",
            models.JSONField(default=dict, db_default={}),
        ),
        migrations.AddField(
            "narrationjob",
            "synthesis_profile",
            models.JSONField(default=dict, db_default={}),
        ),
        migrations.AddField(
            "narrationjob",
            "profile_hash",
            models.CharField(
                default="44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                db_default="44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                max_length=64,
            ),
        ),
        migrations.AddField(
            "audioversion",
            "synthesis_profile",
            models.JSONField(default=dict, db_default={}),
        ),
        migrations.AlterField(
            "audioversion",
            "kind",
            models.CharField(
                max_length=12,
                choices=[
                    ("demo", "Demo"),
                    ("polly", "Polly"),
                    ("fixture", "Test fixture"),
                    ("windows", "Windows development voice"),
                    ("voicevox", "VOICEVOX"),
                ],
            ),
        ),
        migrations.RemoveConstraint(
            "narrationjob", "narration_version_provider_unique"
        ),
        migrations.RemoveConstraint("narrationjob", "narration_provider_valid"),
        migrations.AddConstraint(
            "narrationjob",
            models.UniqueConstraint(
                fields=("document_version", "provider", "profile_hash"),
                name="narration_version_provider_profile_unique",
            ),
        ),
        migrations.AddConstraint(
            "narrationjob",
            models.CheckConstraint(
                condition=models.Q(
                    provider__in=["polly", "windows", "fixture", "voicevox"]
                ),
                name="narration_provider_valid",
            ),
        ),
        migrations.RunSQL(PROFILE_GUARDS, REVERSE_GUARDS),
        migrations.RunPython(migrations.RunPython.noop, refuse_profile_loss),
    ]
