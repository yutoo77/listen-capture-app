"""Product limits and old-reference safety, using real encoders/PostgreSQL."""

import array
import io
import json
import math
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import wave
from unittest.mock import patch

from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from capture import narration, services, storage
from capture.models import AudioVersion
from capture.narration_encoding import encode
from capture import narration_encoding
from capture.narration_provider import ProviderFailure
from capture.narration_models import NarrationJob

from .test_narration import FIXTURE, NarrationSetup


def signal(frames):
    return array.array(
        "h",
        (round(10000 * math.sin(2 * math.pi * n * 440 / 16000)) for n in range(frames)),
    ).tobytes()


@override_settings(NARRATION_ENCODING="mp3")
class GaplessBoundaryTests(SimpleTestCase):
    def test_long_final_sample_boundaries_preserve_the_exact_source_clock(self):
        # The actual long lesson failed at these two sample counts. The small
        # boundary cases also protect both ends of the 1..46-sample LAME limit.
        for frames, content_type in (
            (576 * 100 + 1, "audio/wav"),
            (576 * 100 + 14, "audio/wav"),
            (576 * 100 + 46, "audio/wav"),
            (576 * 100 + 47, "audio/mpeg"),
            (576 * 101, "audio/mpeg"),
            (2529230, "audio/wav"),
            (2450891, "audio/wav"),
        ):
            with self.subTest(frames=frames):
                pcm = bytearray(frames * 2)
                marker = frames // 2
                pcm[marker * 2 : marker * 2 + 2] = (25000).to_bytes(
                    2, "little", signed=True
                )
                pcm[-2:] = (10000).to_bytes(2, "little", signed=True)
                result = encode(pcm)
                self.assertEqual(result.content_type, content_type)
                if content_type == "audio/wav":
                    self.assertEqual(result.suffix, "wav")
                    with wave.open(io.BytesIO(result.data)) as sound:
                        self.assertEqual(sound.getnchannels(), 1)
                        self.assertEqual(sound.getframerate(), 16000)
                        self.assertEqual(sound.getnframes(), frames)
                        self.assertEqual(sound.readframes(frames), pcm)
                    continue
                self.assertEqual(result.suffix, "mp3")
                with tempfile.TemporaryDirectory() as folder:
                    path = Path(folder) / "boundary.mp3"
                    path.write_bytes(result.data)
                    decoded = subprocess.check_output(
                        [
                            settings.FFMPEG_BINARY,
                            "-v",
                            "error",
                            "-i",
                            str(path),
                            "-f",
                            "s16le",
                            "-ar",
                            "16000",
                            "-ac",
                            "1",
                            "pipe:1",
                        ],
                        timeout=30,
                    )
                samples = array.array("h", decoded)
                self.assertEqual(len(samples), frames)
                peak = max(range(len(samples)), key=lambda index: abs(samples[index]))
                self.assertLessEqual(abs(peak - marker), 1)


@override_settings(**{**FIXTURE, "NARRATION_ENCODING": "mp3"})
class EncodingTests(NarrationSetup, TestCase):
    def test_awkward_samples_and_impulse_clock_survive_real_gapless_decode(self):
        for frames in (17, 575, 576, 577, 4095, 4096, 4097, 48001, 160001):
            with self.subTest(frames=frames):
                pcm = bytearray(frames * 2)
                marker = frames // 2
                pcm[marker * 2 : marker * 2 + 2] = (25000).to_bytes(
                    2, "little", signed=True
                )
                result = encode(pcm)
                if frames < 4096:
                    self.assertEqual(result.content_type, "audio/wav")
                    with wave.open(io.BytesIO(result.data)) as sound:
                        self.assertEqual(sound.readframes(frames), pcm)
                    continue
                self.assertEqual(result.content_type, "audio/mpeg")
                self.assertEqual(result.suffix, "mp3")
                with tempfile.TemporaryDirectory() as folder:
                    path = Path(folder) / "sample.mp3"
                    path.write_bytes(result.data)
                    decoded = subprocess.check_output(
                        [
                            settings.FFMPEG_BINARY,
                            "-v",
                            "error",
                            "-i",
                            str(path),
                            "-f",
                            "s16le",
                            "-ar",
                            "16000",
                            "-ac",
                            "1",
                            "pipe:1",
                        ],
                        timeout=30,
                    )
                samples = array.array("h", decoded)
                self.assertEqual(len(samples), frames)
                peak = max(range(len(samples)), key=lambda index: abs(samples[index]))
                self.assertLessEqual(
                    abs(peak - marker), 1, "Encoder delay shifted source time"
                )

    def test_encoding_failure_preserves_partials_and_retry_never_resynthesizes(self):
        job = self.queued()
        with override_settings(FFMPEG_BINARY="missing-listen-capture-test-encoder"):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(
            (job.state, job.error_code), ("failed", "audio_encoding_failed")
        )
        original = list(job.segments.values_list("storage_key", "digest"))
        self.assertTrue(all(key and digest for key, digest in original))
        self.assertFalse(AudioVersion.objects.exists())
        response = self.retry(job)
        self.assertEqual(response.status_code, 202)
        with (
            patch("capture.narration_provider.synthesize") as synth,
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        self.assertEqual(job.audio_version.content_type, "audio/mpeg")
        self.assertEqual(job.audio_version.duration_ms, 3000 * job.segments.count())
        self.assertEqual(len(list(storage.objects())), 1)

    def test_private_range_and_old_wav_identity_coexist_without_rewriting(self):
        with override_settings(NARRATION_ENCODING="wav"):
            old = self.queued()
            with self.captureOnCommitCallbacks(execute=True):
                narration.work_once()
        old.refresh_from_db()
        old_audio = old.audio_version
        before = storage.read_bytes(old_audio.storage_key, max_bytes=1000000)
        old_id = old_audio.id
        old.delete()  # A later generation gets a new version, never replaces media.
        new = self.queued()
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        new.refresh_from_db()
        audio = new.audio_version
        self.assertNotEqual(audio.id, old_id)
        self.assertEqual(
            storage.read_bytes(old_audio.storage_key, max_bytes=1000000), before
        )
        part = audio.segments.first()
        self.assertEqual(part.content_type, "audio/mpeg")
        url = f"/api/audio/{audio.id}/segments/0/content/"
        foreign = APIClient()
        foreign.force_authenticate(self.other)
        with patch("capture.storage.stat") as stat:
            self.assertEqual(foreign.get(url).status_code, 404)
            self.assertEqual(APIClient().get(url).status_code, 403)
        stat.assert_not_called()
        response = self.client.get(url, HTTP_RANGE="bytes=0-43")
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response["Content-Type"], "audio/mpeg")
        self.assertEqual(len(b"".join(response.streaming_content)), 44)
        self.assertEqual(
            self.client.head(url).get("Content-Length"), str(part.size_bytes)
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            audio.segments.filter(pk=part.pk).update(frames=part.frames + 1)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def test_invalid_input_and_failed_verification_never_publish(self):
        for pcm in (b"", b"x", b"xx" * (16000 * 600 + 1)):
            with self.subTest(length=len(pcm)), self.assertRaises(ProviderFailure):
                encode(pcm)
        # An encoder that exits successfully but produces nothing is not success.
        with (
            patch("capture.narration_encoding._run", return_value=b""),
            self.assertRaises(ProviderFailure),
        ):
            encode(signal(16000))
        with patch(
            "capture.narration_encoding.tempfile.TemporaryDirectory",
            side_effect=OSError("synthetic disk full"),
        ):
            with self.assertRaises(ProviderFailure) as failure:
                encode(signal(16000))
            self.assertEqual(failure.exception.code, "audio_encoding_failed")

    def test_successful_encoder_without_gapless_metadata_is_rejected(self):
        run = narration_encoding._run

        def omit_gapless_metadata(arguments):
            arguments = list(arguments)
            if "-write_xing" in arguments:
                arguments[arguments.index("-write_xing") + 1] = "0"
            return run(arguments)

        with patch(
            "capture.narration_encoding._run", side_effect=omit_gapless_metadata
        ):
            with self.assertRaises(ProviderFailure) as failure:
                encode(signal(48001))
        self.assertEqual(failure.exception.code, "audio_encoding_failed")

    def test_mp3_and_tiny_wav_remainder_publish_one_exact_immutable_timeline(self):
        document = services.create_document(
            self.owner, {"title": "Tiny remainder", "text": "短い試験資料。"}
        )
        job, _ = narration.enqueue(
            self.owner,
            document.id,
            document.versions.first().id,
            uuid.uuid4(),
            "fixture",
        )
        # Five minutes plus 17 samples: the final 1.0625ms must not disappear.
        pcm = b"\x01\0" * (4800000 + 17)
        with (
            patch("capture.narration_provider.synthesize", return_value=pcm),
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        audio = job.audio_version
        parts = list(audio.segments.all())
        self.assertEqual(
            [part.content_type for part in parts], ["audio/mpeg", "audio/wav"]
        )
        self.assertEqual([part.frames for part in parts], [4800000, 17])
        self.assertEqual(audio.duration_ms, 300002)
        self.assertEqual(
            (parts[0].end_ms, parts[1].start_ms, parts[1].end_ms),
            (300000, 300000, 300002),
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
        payload = self.client.get(f"/api/audio/{audio.id}/playlist/").json()
        self.assertEqual(
            [item["content_type"] for item in payload["segments"]],
            ["audio/mpeg", "audio/wav"],
        )
        tail = self.client.get(payload["segments"][1]["media_url"])
        self.assertEqual(tail["Content-Type"], "audio/wav")
        with wave.open(io.BytesIO(b"".join(tail.streaming_content))) as sound:
            self.assertEqual(sound.readframes(17), pcm[-34:])

    def test_long_wav_boundary_and_mp3_publish_one_exact_immutable_timeline(self):
        document = services.create_document(
            self.owner, {"title": "Exact source clock", "text": "あ" * 3001}
        )
        job, _ = narration.enqueue(
            self.owner,
            document.id,
            document.versions.first().id,
            uuid.uuid4(),
            "fixture",
        )
        # Neither asset is tiny. The first has the same final 14-sample
        # boundary that rejected a real multi-minute Polly partial.
        pcm = [b"\x01\0" * 57614, b"\x02\0" * 57647]
        with (
            patch("capture.narration_provider.synthesize", side_effect=pcm),
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        audio = job.audio_version
        parts = list(audio.segments.all())
        self.assertEqual(
            [part.content_type for part in parts], ["audio/wav", "audio/mpeg"]
        )
        self.assertEqual([part.frames for part in parts], [57614, 57647])
        self.assertEqual(audio.duration_ms, 7204)
        self.assertEqual(
            [(part.start_ms, part.end_ms) for part in parts],
            [(0, 3601), (3601, 7204)],
        )
        self.assertEqual(
            [(part.start_offset, part.end_offset) for part in parts],
            [(0, 3000), (3000, 3001)],
        )
        payload = self.client.get(f"/api/audio/{audio.id}/playlist/").json()
        self.assertEqual(
            [item["content_type"] for item in payload["segments"]],
            ["audio/wav", "audio/mpeg"],
        )
        first = self.client.get(payload["segments"][0]["media_url"])
        self.assertEqual(first["Content-Type"], "audio/wav")
        with wave.open(io.BytesIO(b"".join(first.streaming_content))) as sound:
            self.assertEqual(sound.readframes(57614), pcm[0])
        with self.assertRaises(IntegrityError), transaction.atomic():
            audio.segments.filter(pk=parts[0].pk).update(frames=57615)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def test_failed_playlist_commit_removes_staged_mp3_and_reuses_all_pcm(self):
        job = self.queued()
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch(
                "capture.models.AudioSegment.objects.bulk_create",
                side_effect=IntegrityError("synthetic publication rejection"),
            ),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "failed")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertTrue(all(item.key.endswith(".pcm") for item in storage.objects()))
        self.assertEqual(self.retry(job).status_code, 202)
        with (
            patch("capture.narration.SINGLE_MAX_FRAMES", 1),
            patch("capture.narration_provider.synthesize") as synth,
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded", job.error_code)
        self.assertTrue(all(item.key.endswith(".mp3") for item in storage.objects()))

    @override_settings(
        LC_E2E_LONG_AUDIO=True, LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT=600
    )
    def test_five_thirty_minute_lessons_fit_default_quota_without_discarding_sources(
        self,
    ):
        measurements = []
        started = time.monotonic()
        for number in range(5):
            document = services.create_document(
                self.owner, {"title": f"30-minute lesson {number}", "text": "あ" * 9000}
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
            with (
                self.captureOnCommitCallbacks(execute=True),
                patch("capture.narration_provider.boto3.client") as aws,
            ):
                narration.work_once()
            aws.assert_not_called()
            job = NarrationJob.objects.get(pk=response.data["id"])
            self.assertEqual(job.state, "succeeded", job.error_code)
            audio = job.audio_version
            self.assertEqual(audio.duration_ms, 1800000)
            self.assertEqual(audio.segments.count(), 6)
            self.assertLessEqual(audio.size_bytes, 20 * 1024 * 1024)
            measurements.append(
                {"duration_ms": audio.duration_ms, "size_bytes": audio.size_bytes}
            )
        self.assertEqual(AudioVersion.objects.count(), 5)
        self.assertEqual(len(list(storage.objects())), 30)
        total = sum(item["size_bytes"] for item in measurements)
        self.assertLess(total, 200 * 1024 * 1024)
        print(
            "CODEC_CAPACITY "
            + json.dumps(
                {
                    "signal": "artificial 100Hz, not Japanese speech",
                    "lessons": measurements,
                    "total_bytes": total,
                    "wall_seconds": round(time.monotonic() - started, 3),
                }
            )
        )


@override_settings(**{**FIXTURE, "NARRATION_ENCODING": "mp3"})
class PublicationInterruptionTests(NarrationSetup, TransactionTestCase):
    def test_interrupt_after_db_commit_cannot_delete_published_single_audio(self):
        job = self.queued()
        delete = storage.delete_key

        def interrupt_old_partial(key):
            if key.endswith(".pcm"):
                raise KeyboardInterrupt("synthetic post-commit worker interruption")
            return delete(key)

        with patch("capture.storage.delete_key", side_effect=interrupt_old_partial):
            with self.assertRaises(KeyboardInterrupt):
                narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        audio = job.audio_version
        self.assertEqual(audio.content_type, "audio/mpeg")
        self.assertEqual(storage.stat(audio.storage_key).size_bytes, audio.size_bytes)
        response = self.client.get(f"/api/audio/{audio.id}/content/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(b"".join(response.streaming_content)), audio.size_bytes)
