import io
import uuid
import wave
from datetime import timedelta
from unittest.mock import patch

from django.db import IntegrityError, connection, transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from capture import narration, narration_provider, services, storage
from capture.models import AudioSegment, AudioVersion
from capture.narration_models import NarrationJob

from .test_narration import FIXTURE, NarrationSetup


@override_settings(**FIXTURE)
class PlaylistTests(NarrationSetup, TestCase):
    def publish(self):
        job = self.queued()
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch("capture.narration.PUBLISHED_SEGMENT_FRAMES", 32000),
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        return job, job.audio_version

    def test_manifest_exact_frame_timeline_and_source_survive_job_cleanup(self):
        job, audio = self.publish()
        self.assertEqual(audio.delivery, "playlist")
        self.assertIsNone(audio.storage_key)
        items = list(audio.segments.all())
        self.assertEqual(len(items), job.segments.count() * 2)
        self.assertEqual(audio.size_bytes, sum(item.size_bytes for item in items))
        self.assertEqual(len(list(storage.objects())), len(items))
        self.assertFalse(job.segments.exclude(storage_key=None).exists())
        response = self.client.get(f"/api/audio/{audio.id}/playlist/")
        self.assertEqual(response.status_code, 200)
        manifest = response.json()
        for index, item in enumerate(manifest["segments"]):
            self.assertEqual(item["index"], index)
            self.assertEqual(
                item["start_ms"],
                0 if index == 0 else manifest["segments"][index - 1]["end_ms"],
            )
            self.assertTrue(item["block_ids"])
            self.assertLessEqual(item["duration_ms"], 300000)
        self.assertEqual(manifest["segments"][-1]["end_ms"], audio.duration_ms)
        job.delete()
        self.assertEqual(
            self.client.get(f"/api/audio/{audio.id}/playlist/").json(), manifest
        )
        self.assertEqual(
            self.client.get(f"/api/audio/{audio.id}/narration-map/").json()[
                "precision"
            ],
            "segment",
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def test_segments_are_owner_first_range_and_head_and_single_route_is_404(self):
        _, audio = self.publish()
        segment = audio.segments.first()
        url = f"/api/audio/{audio.id}/segments/0/content/"
        foreign = APIClient()
        foreign.force_authenticate(self.other)
        with patch("capture.storage.stat") as stat:
            self.assertEqual(foreign.get(url).status_code, 404)
            self.assertEqual(
                foreign.get(f"/api/audio/{audio.id}/playlist/").status_code, 404
            )
            self.assertEqual(APIClient().get(url).status_code, 403)
        stat.assert_not_called()
        head = self.client.head(url, HTTP_RANGE="bytes=0-43")
        self.assertEqual(head.status_code, 206)
        self.assertEqual(head["Content-Length"], "44")
        result = self.client.get(url, HTTP_RANGE="bytes=0-43")
        self.assertEqual(result.status_code, 206)
        self.assertEqual(b"".join(result.streaming_content)[:4], b"RIFF")
        self.assertEqual(result["Content-Range"], f"bytes 0-43/{segment.size_bytes}")
        self.assertEqual(
            self.client.get(url, HTTP_RANGE="bytes=999999999-").status_code, 416
        )
        self.assertEqual(
            self.client.get(f"/api/audio/{audio.id}/content/").status_code, 404
        )

    def test_playlist_metadata_is_immutable_in_app_and_postgresql(self):
        _, audio = self.publish()
        segment = audio.segments.first()
        segment.start_offset = 1
        with self.assertRaises(ValueError):
            segment.save()
        with transaction.atomic(), self.assertRaises(IntegrityError):
            with transaction.atomic():
                AudioSegment.objects.filter(pk=segment.pk).update(start_offset=1)
        with transaction.atomic(), self.assertRaises(IntegrityError):
            with transaction.atomic():
                AudioVersion.objects.filter(pk=audio.pk).update(
                    duration_ms=audio.duration_ms + 1
                )

    def test_database_rejects_incomplete_or_noncontiguous_manifest(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            AudioVersion.objects.create(
                document_version=self.version,
                kind="fixture",
                delivery="playlist",
                storage_key=None,
                size_bytes=44,
                duration_ms=1,
            )
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        _, audio = self.publish()
        with self.assertRaises(IntegrityError), transaction.atomic():
            audio.segments.first().delete()
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def test_stale_publish_cleans_staged_assets_and_retry_reuses_partial_success(self):
        job = self.queued()
        put = storage.put_bytes
        baseline_depth = len(connection.savepoint_ids)

        def expire_after_put(data, suffix):
            self.assertEqual(
                len(connection.savepoint_ids),
                baseline_depth,
                "Storage I/O must not add a DB transaction",
            )
            key = put(data, suffix)
            if suffix == "wav":
                NarrationJob.objects.filter(pk=job.pk).update(
                    lease_expires_at=timezone.now() - timedelta(seconds=1)
                )
            return key

        # TestCase has its own outer transaction; production I/O must not open
        # an additional transaction/savepoint around private storage operations.
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch("capture.storage.put_bytes", side_effect=expire_after_put),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "failed")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertTrue(all(obj.key.endswith(".pcm") for obj in storage.objects()))
        self.assertEqual(self.retry(job).status_code, 202)
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch("capture.narration_provider.synthesize") as synth,
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_single_manifest_keeps_existing_media_and_global_progress_identity(self):
        job = self.queued()
        narration.work_once()
        job.refresh_from_db()
        audio = job.audio_version
        self.assertEqual(audio.delivery, "single")
        data = self.client.get(f"/api/audio/{audio.id}/playlist/").json()
        self.assertEqual(data["segments"][0]["end_ms"], audio.duration_ms)
        self.assertEqual(
            data["segments"][0]["media_url"], f"/api/audio/{audio.id}/content/"
        )
        job.delete()
        _, playlist = self.publish()
        result = self.client.put(
            f"/api/audio/{playlist.id}/progress/",
            {
                "position_ms": playlist.duration_ms - 1,
                "revision": 0,
                "client_id": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(
            self.client.get(f"/api/audio/{playlist.id}/progress/").json()[
                "position_ms"
            ],
            playlist.duration_ms - 1,
        )

    @override_settings(
        LC_E2E_LONG_AUDIO=True, LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT=600
    )
    def test_real_sixty_minute_playlist_bounded_assets_and_net_owner_quota(self):
        document = services.create_document(
            self.owner, {"title": "60 minute test signal", "text": "あ" * 18000}
        )
        response = self.client.post(
            f"/api/documents/{document.id}/narration/",
            {
                "document_version": str(document.versions.first().id),
                "provider": "fixture",
                "client_id": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(response.status_code, 202, response.data)
        job = NarrationJob.objects.get(pk=response.data["id"])
        # 115.2MB partials plus 115.2MB assets temporarily exist, but the
        # committed account use is 115.2MB, below the normal 200MiB quota.
        with (
            self.captureOnCommitCallbacks(execute=True),
            patch("capture.narration_provider.boto3.client") as aws,
        ):
            narration.work_once()
        aws.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        audio = job.audio_version
        self.assertEqual(audio.duration_ms, 3600000)
        self.assertEqual(audio.segments.count(), 12)
        self.assertLess(audio.size_bytes, 116000000)
        self.assertEqual(len(list(storage.objects())), 12)
        for segment in audio.segments.all():
            self.assertLessEqual(segment.size_bytes, 9600044)
        with wave.open(
            io.BytesIO(
                storage.read_bytes(
                    audio.segments.first().storage_key, max_bytes=9600044
                )
            )
        ) as sound:
            self.assertEqual(sound.getnframes(), 4800000)
            self.assertTrue(any(sound.readframes(160)))
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
            cursor.execute("SET CONSTRAINTS ALL DEFERRED")
        with self.captureOnCommitCallbacks(execute=True):
            document.delete()
        self.assertFalse(list(storage.objects()))

    def test_long_test_signal_requires_explicit_fixture_guards(self):
        with override_settings(LC_E2E_LONG_AUDIO=True, LC_E2E_FIXTURE_TTS=False):
            with self.assertRaises(narration_provider.ProviderFailure):
                narration_provider.synthesize("本文", "fixture")
        with override_settings(
            LC_E2E_LONG_AUDIO=True, LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT=601
        ):
            with self.assertRaises(narration_provider.ProviderFailure):
                narration_provider.synthesize("本文", "fixture")

    def test_database_publication_failure_compensates_all_new_assets(self):
        job = self.queued()
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch(
                "capture.models.AudioSegment.objects.bulk_create",
                side_effect=IntegrityError("synthetic publication failure"),
            ),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "failed")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertFalse(AudioSegment.objects.exists())
        self.assertEqual(len(list(storage.objects())), job.segments.count())
        self.assertTrue(all(obj.key.endswith(".pcm") for obj in storage.objects()))
        self.assertFalse(job.segments.exclude(state="succeeded").exists())

    def test_fractional_milliseconds_do_not_accumulate_or_overlap(self):
        job = self.queued()
        frames_per_partial = 48001
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch("capture.narration.PUBLISHED_SEGMENT_FRAMES", 32000),
            patch(
                "capture.narration_provider.synthesize",
                return_value=b"\x01\0" * frames_per_partial,
            ),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        audio = job.audio_version
        frames = 0
        previous_end = 0
        for segment in audio.segments.all():
            self.assertEqual(segment.start_ms, previous_end)
            frames += segment.frames
            self.assertEqual(segment.end_ms, (frames * 1000 + 15999) // 16000)
            previous_end = segment.end_ms
        self.assertEqual(frames, frames_per_partial * job.segments.count())
        self.assertEqual(audio.duration_ms, previous_end)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
