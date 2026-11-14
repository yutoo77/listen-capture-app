from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("capture", "0010_voicevox_profiles")]

    operations = [
        migrations.AddField(
            model_name="narrationjob",
            name="cancel_requested_at",
            field=models.DateTimeField(null=True),
        ),
    ]
