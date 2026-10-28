import io
import os
import subprocess
import tempfile
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.db import close_old_connections, connection, connections
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from capture import generation, narration, narration_provider, services, storage
from capture.models import AudioVersion, GlobalTtsBudget, TtsCapacityReservation
from capture.narration_models import NarrationJob, NarrationRequest, NarrationSegment

FIXTURE = {
    "NARRATION_ENCODING": "wav",
    "LC_E2E_FIXTURE_TTS": True,
    "LC_TEST_ENVIRONMENT": True,
    "AWS_METADATA_DISABLED": True,
    "DEBUG": True,
    "POLLY_ENABLED": False,
    "POLLY_BILLING_APPROVED": False,
    "TTS_DAILY_USER_CHARACTERS": 100000,
    "PASSWORD_HASHERS": ["django.contrib.auth.hashers.MD5PasswordHasher"],
}
PCM = b"\x01\x00" * 1600


@override_settings(**FIXTURE)
class NarrationPollySafetyTests(SimpleTestCase):
    def test_polly_duration_boundary_and_cutoff_are_rejected_with_closed_stream(self):
        maximum = narration_provider.POLLY_SEGMENT_MAX_FRAMES
        self.assertEqual(maximum, 16000 * 570)
        for frames in (maximum - 1, maximum, maximum + 1, 16000 * 600):
            with self.subTest(frames=frames):
                pcm = b"\x01\x00" * frames
                stream = io.BytesIO(pcm)
                with patch("capture.narration_provider.boto3.client") as aws:
                    aws.return_value.synthesize_speech.return_value = {
                        "AudioStream": stream
                    }
                    if frames < maximum:
                        self.assertEqual(narration_provider._polly_pcm("本文。"), pcm)
                    else:
                        with self.assertRaises(
                            narration_provider.ProviderFailure
                        ) as failure:
                            narration_provider._polly_pcm("本文。")
                        self.assertEqual(failure.exception.code, "audio_too_long")
                self.assertTrue(stream.closed)
                aws.return_value.synthesize_speech.assert_called_once()

    def test_polly_child_keeps_cutoff_failure_distinct_from_unknown_execution(self):
        with patch(
            "capture.narration_provider._bounded_child",
            return_value=subprocess.CompletedProcess([], 43, b"", b""),
        ) as child:
            with self.assertRaises(narration_provider.ProviderFailure) as failure:
                narration_provider._polly_process("本文。")
        self.assertEqual(failure.exception.code, "audio_too_long")
        child.assert_called_once()

    def test_polly_cap_is_additive_and_other_providers_keep_the_existing_maximum(self):
        config = narration_provider.configuration()
        self.assertEqual(config["segment_max_characters"], 3000)
        paid = next(item for item in config["providers"] if item["id"] == "polly")
        self.assertEqual(paid["segment_max_characters"], 1500)
        self.assertFalse(paid["enabled"])

    def test_twenty_thousand_code_points_keep_exact_offsets_with_non_bmp_text(self):
        text = "日本語😀\n" * 4000
        self.assertEqual(len(text), 20000)
        ranges = narration.split_ranges(
            text, [], narration_provider.POLLY_SEGMENT_MAX_CHARACTERS
        )
        self.assertTrue(all(0 < end - start <= 1500 for start, end in ranges))
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], len(text))
        self.assertTrue(
            all(left[1] == right[0] for left, right in zip(ranges, ranges[1:]))
        )
        self.assertEqual("".join(text[start:end] for start, end in ranges), text)

    @override_settings(
        LC_E2E_LONG_AUDIO=True, LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT=600
    )
    def test_six_hundred_second_capacity_fixture_is_not_subject_to_polly_cutoff(self):
        pcm = narration_provider.synthesize("人工試験。", "fixture")
        self.assertEqual(len(pcm), 16000 * 2 * 600)


class NarrationSetup:
    def setUp(self):
        super().setUp()
        cache.clear()
        self.directory = tempfile.TemporaryDirectory()
        self.setting = override_settings(PRIVATE_MEDIA_ROOT=Path(self.directory.name))
        self.setting.enable()
        self.addCleanup(self.setting.disable)
        self.addCleanup(self.directory.cleanup)
        self.owner = get_user_model().objects.create_user(
            "narration-owner", password="testing-password"
        )
        self.other = get_user_model().objects.create_user("narration-other")
        self.text = ("日本語の文章。" * 500 + "\n\n") * 2
        self.document = services.create_document(
            self.owner, {"title": "長い日本語", "text": self.text}
        )
        self.version = self.document.versions.first()
        self.url = f"/api/documents/{self.document.id}/narration/"
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def start(self, key=None, **changes):
        return self.client.post(
            self.url,
            {
                "document_version": str(self.version.id),
                "client_id": str(key or uuid.uuid4()),
                "provider": "fixture",
                **changes,
            },
            format="json",
        )

    def queued(self):
        response = self.start()
        self.assertEqual(response.status_code, 202, response.data)
        return NarrationJob.objects.get(pk=response.data["id"])

    def retry(self, job, key=None, **changes):
        return self.client.post(
            f"/api/narrations/{job.id}/retry/",
            {
                "client_id": str(key or uuid.uuid4()),
                **changes,
            },
            format="json",
        )


@override_settings(**FIXTURE)
class NarrationTests(NarrationSetup, TestCase):
    def test_no_current_job_is_explicit_json_null_for_browser_json_parsing(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"null")
        self.assertIsNone(response.json())
        self.assertEqual(response["Content-Type"], "application/json")

    def test_exact_segmentation_snapshot_and_truthful_fixture_publish(self):
        job = self.queued()
        segments = list(job.segments.all())
        self.assertGreater(len(segments), 2)
        self.assertEqual(job.reading_text, self.version.text)
        self.assertEqual(
            "".join(job.reading_text[s.start_offset : s.end_offset] for s in segments),
            self.text,
        )
        self.assertTrue(
            all(0 < s.end_offset - s.start_offset <= 3000 for s in segments)
        )
        with (
            patch("capture.narration_provider.boto3.client") as aws,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self.assertTrue(narration.work_once())
        aws.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        audio = job.audio_version
        self.assertEqual(audio.kind, "fixture")
        self.assertEqual(audio.content_type, "audio/wav")
        data = storage.read_bytes(audio.storage_key, max_bytes=1000000)
        with wave.open(io.BytesIO(data)) as sound:
            self.assertEqual(
                (sound.getnchannels(), sound.getsampwidth(), sound.getframerate()),
                (1, 2, 16000),
            )
            self.assertEqual(sound.getnframes(), 48000 * len(segments))
        self.assertEqual(audio.duration_ms, 3000 * len(segments))
        self.assertEqual(len(list(storage.objects())), 1)
        self.assertFalse(job.segments.exclude(storage_key=None).exists())
        mapping = self.client.get(f"/api/audio/{audio.id}/narration-map/")
        self.assertEqual(mapping.status_code, 200)
        self.assertEqual(mapping.data["precision"], "segment")
        self.assertEqual(mapping.data["segments"][0]["start_ms"], 0)
        self.assertEqual(mapping.data["segments"][-1]["end_ms"], audio.duration_ms)
        self.assertTrue(all(item["block_ids"] for item in mapping.data["segments"]))
        self.assertEqual(self.client.get(self.url).data["id"], str(job.id))

    @override_settings(POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True)
    def test_new_polly_segments_are_shorter_without_changing_source_or_replay(self):
        fixture = self.queued()
        fixture_ranges = list(
            fixture.segments.values_list("start_offset", "end_offset")
        )
        response = self.start(provider="polly")
        self.assertEqual(response.status_code, 202, response.data)
        paid = NarrationJob.objects.get(pk=response.data["id"])
        ranges = list(paid.segments.values_list("start_offset", "end_offset"))
        self.assertTrue(all(0 < end - start <= 1500 for start, end in ranges))
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], len(self.text))
        self.assertTrue(
            all(left[1] == right[0] for left, right in zip(ranges, ranges[1:]))
        )
        self.assertEqual(
            "".join(paid.reading_text[start:end] for start, end in ranges), self.text
        )
        self.assertEqual(self.start(provider="polly").status_code, 200)
        self.assertEqual(
            list(paid.segments.values_list("start_offset", "end_offset")), ranges
        )
        self.assertEqual(
            list(fixture.segments.values_list("start_offset", "end_offset")),
            fixture_ranges,
        )
        self.assertTrue(any(end - start > 1500 for start, end in fixture_ranges))

    @override_settings(POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True)
    def test_possibly_truncated_polly_never_publishes_or_automatically_retries(self):
        response = self.start(provider="polly")
        self.assertEqual(response.status_code, 202, response.data)
        job = NarrationJob.objects.get(pk=response.data["id"])
        pcm = b"\x01\x00" * narration_provider.POLLY_SEGMENT_MAX_FRAMES
        with patch(
            "capture.narration_provider.synthesize", return_value=pcm
        ) as provider:
            narration.work_once()
            self.assertFalse(narration.work_once())
        provider.assert_called_once()
        job.refresh_from_db()
        self.assertEqual((job.state, job.error_code), ("failed", "audio_too_long"))
        first = job.segments.first()
        self.assertEqual((first.state, first.attempt_count), ("failed", 1))
        self.assertIsNone(first.storage_key)
        self.assertFalse(AudioVersion.objects.exists())
        self.assertFalse(list(storage.objects()))
        self.assertFalse(TtsCapacityReservation.objects.exists())
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved, len(self.text)
        )

    @override_settings(POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True)
    def test_existing_polly_job_keeps_previously_accepted_three_thousand_offsets(self):
        existing = self.queued()
        existing.provider = "polly"
        existing.save(update_fields=["provider"])
        ranges = list(existing.segments.values_list("start_offset", "end_offset"))
        self.assertTrue(any(end - start > 1500 for start, end in ranges))
        response = self.start(provider="polly")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["id"], str(existing.pk))
        self.assertEqual(
            list(existing.segments.values_list("start_offset", "end_offset")), ranges
        )

    def test_partial_success_explicit_retry_reuses_audio_and_reserves_only_remaining_text(
        self,
    ):
        job = self.queued()
        with patch(
            "capture.narration_provider.synthesize",
            side_effect=[PCM, narration_provider.ProviderFailure("provider_rejected")],
        ) as synth:
            narration.work_once()
        self.assertEqual(synth.call_count, 2)
        job.refresh_from_db()
        first = job.segments.first()
        self.assertEqual((job.state, first.state), ("failed", "succeeded"))
        self.assertEqual(storage.read_bytes(first.storage_key, max_bytes=10000), PCM)
        self.assertFalse(narration.work_once())
        remaining = list(job.segments.exclude(state="succeeded"))
        key = uuid.uuid4()
        response = self.retry(job, key)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(self.retry(job, key).status_code, 200)
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved,
            len(self.text) + sum(s.end_offset - s.start_offset for s in remaining),
        )
        with (
            patch("capture.narration_provider.synthesize", return_value=PCM) as synth,
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        self.assertEqual(synth.call_count, len(remaining))
        first.refresh_from_db()
        self.assertEqual(first.attempt_count, 1)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.assertEqual(AudioVersion.objects.count(), 1)

    def test_unknown_needs_separate_explicit_ack_and_no_automatic_reexecution(self):
        job = self.queued()
        with patch(
            "capture.narration_provider.synthesize",
            side_effect=narration_provider.ProviderFailure("execution_unknown"),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.segments.first().state, "unknown")
        self.assertFalse(narration.work_once())
        self.assertEqual(self.retry(job).status_code, 409)
        self.assertEqual(
            self.client.get(f"/api/narrations/{job.id}/").data["has_unknown"], True
        )
        self.assertEqual(self.retry(job, acknowledge_unknown=True).status_code, 202)
        with patch("capture.narration_provider.synthesize", return_value=PCM):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_lost_start_response_and_alias_requests_do_not_rebudget_or_duplicate(self):
        key = uuid.uuid4()
        first = self.start(key)
        second = self.start(key)
        alias = self.start()
        self.assertEqual(
            [first.status_code, second.status_code, alias.status_code], [202, 200, 200]
        )
        self.assertEqual(first.data["id"], alias.data["id"])
        self.assertEqual(NarrationJob.objects.count(), 1)
        self.assertEqual(NarrationRequest.objects.count(), 2)
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved, len(self.text)
        )
        self.assertEqual(self.start(key, provider="windows").status_code, 409)

    def test_authorization_csrf_foreign_map_and_current_version_checks(self):
        job = self.queued()
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.start().status_code, 404)
        self.assertEqual(self.retry(job).status_code, 404)
        self.assertEqual(self.client.get(f"/api/narrations/{job.id}/").status_code, 404)
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get("/api/narration/config/").status_code, 403)
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.owner)
        self.assertEqual(
            csrf_client.post(
                self.url,
                {
                    "document_version": str(self.version.id),
                    "client_id": str(uuid.uuid4()),
                    "provider": "fixture",
                },
                format="json",
            ).status_code,
            403,
        )
        self.client.force_authenticate(self.owner)
        services.update_document(self.owner, self.document.id, {"text": "新しい版。"})
        self.assertEqual(self.start().status_code, 409)

    def test_expired_segment_lease_is_unknown_and_old_worker_cannot_call_provider(self):
        self.queued()
        claimed = narration.claim_job()
        segment = claimed.segments.first()
        segment.state, segment.attempt_count = "running", 1
        segment.save()
        NarrationJob.objects.filter(pk=claimed.pk).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        narration.expire_leases()
        segment.refresh_from_db()
        self.assertEqual(segment.state, "unknown")
        with patch("capture.narration_provider.synthesize") as synth:
            narration.process_job(claimed)
        synth.assert_not_called()
        self.assertEqual(AudioVersion.objects.count(), 0)

    def test_provider_result_after_lease_expiry_is_not_published_or_retried(self):
        job = self.queued()

        def expire_during_call(*args):
            NarrationJob.objects.filter(pk=job.pk).update(
                lease_expires_at=timezone.now() - timedelta(seconds=1)
            )
            return PCM

        with patch(
            "capture.narration_provider.synthesize", side_effect=expire_during_call
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "execution_unknown")
        self.assertEqual(job.segments.first().state, "unknown")
        self.assertFalse(list(storage.objects()))
        self.assertFalse(narration.work_once())

    def test_parent_deletion_erases_snapshot_partials_and_tombstone_blocks_recreation(
        self,
    ):
        key = uuid.uuid4()
        response = self.start(key)
        job = NarrationJob.objects.get(pk=response.data["id"])
        with patch(
            "capture.narration_provider.synthesize",
            side_effect=[PCM, narration_provider.ProviderFailure("provider_rejected")],
        ):
            narration.work_once()
        self.assertEqual(len(list(storage.objects())), 1)
        with self.captureOnCommitCallbacks(execute=True):
            self.document.delete()
        job.refresh_from_db()
        self.assertEqual(job.reading_text, "")
        self.assertEqual(job.error_code, "parent_deleted")
        self.assertEqual(job.segments.count(), 0)
        self.assertFalse(list(storage.objects()))
        self.assertEqual(self.start(key).data["id"], str(job.id))
        self.assertEqual(self.start().status_code, 404)

    def test_deletion_during_generation_never_leaves_new_audio_or_partial(self):
        job = self.queued()

        def delete_during_call(*args):
            self.document.delete()
            return PCM

        with (
            patch(
                "capture.narration_provider.synthesize", side_effect=delete_during_call
            ),
            self.captureOnCommitCallbacks(execute=True),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "parent_deleted")
        self.assertEqual(AudioVersion.objects.count(), 0)
        self.assertFalse(list(storage.objects()))

    @override_settings(TTS_DAILY_USER_CHARACTERS=100)
    def test_whole_text_budget_rejection_leaves_no_job_or_reservation(self):
        self.assertEqual(self.start().status_code, 429)
        self.assertFalse(NarrationJob.objects.exists())
        self.assertFalse(GlobalTtsBudget.objects.exists())

    def test_windows_never_enabled_in_production_even_with_explicit_flag(self):
        with (
            override_settings(DEBUG=False, LC_LOCAL_WINDOWS_TTS=True),
            patch(
                "capture.narration_provider.installed_windows_voice", return_value=True
            ),
        ):
            self.assertFalse(narration_provider.enabled("windows"))
            self.assertEqual(self.start(provider="windows").status_code, 503)

    def test_polly_both_cost_flags_and_no_fallback_are_required(self):
        for enabled, approved in [(False, False), (True, False), (False, True)]:
            with (
                self.subTest(enabled=enabled, approved=approved),
                override_settings(
                    POLLY_ENABLED=enabled, POLLY_BILLING_APPROVED=approved
                ),
                patch("capture.narration_provider.boto3.client") as aws,
            ):
                self.assertEqual(self.start(provider="polly").status_code, 503)
                aws.assert_not_called()

    def test_missing_successful_partial_is_explicitly_repaired_without_regenerating_other_successes(
        self,
    ):
        job = self.queued()
        with patch(
            "capture.narration_provider.synthesize",
            side_effect=[PCM, narration_provider.ProviderFailure("provider_rejected")],
        ):
            narration.work_once()
        first = job.segments.first()
        storage.delete_key(first.storage_key)
        self.assertEqual(self.retry(job).status_code, 202)
        with patch("capture.narration_provider.synthesize", return_value=PCM):
            narration.work_once()
        first.refresh_from_db()
        self.assertEqual((first.state, first.error_code), ("failed", "storage_failed"))
        self.assertEqual(self.retry(job).status_code, 202)
        with patch("capture.narration_provider.synthesize", return_value=PCM) as synth:
            narration.work_once()
        self.assertEqual(synth.call_count, 1)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_pcm_duration_cap_never_publishes_a_truncated_audio(self):
        job = self.queued()
        with (
            patch("capture.narration_provider.MAX_TOTAL_BYTES", 100),
            patch("capture.narration_provider.synthesize", return_value=PCM),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "audio_too_long")
        self.assertFalse(AudioVersion.objects.exists())
        self.assertFalse(list(storage.objects()))

    def test_file_is_compensated_if_database_rejects_the_partial_reference(self):
        job = self.queued()
        original = NarrationSegment.save

        def fail_reference(segment, *args, **kwargs):
            if segment.state == "succeeded":
                raise RuntimeError("synthetic database failure")
            return original(segment, *args, **kwargs)

        with (
            patch("capture.narration_provider.synthesize", return_value=PCM),
            patch.object(NarrationSegment, "save", fail_reference),
        ):
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.error_code, "execution_unknown")
        self.assertFalse(list(storage.objects()))
        self.assertFalse(job.segments.exclude(storage_key=None).exists())

    def test_polly_child_hard_timeout_is_unknown_and_never_retried(self):
        with patch(
            "capture.narration_provider._bounded_child",
            side_effect=subprocess.TimeoutExpired("polly-child", 120),
        ) as run:
            with self.assertRaises(narration_provider.ProviderFailure) as failure:
                narration_provider._polly_process("日本語。")
        self.assertEqual(failure.exception.code, "execution_unknown")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.kwargs["timeout"], 120)
        self.assertNotIn("日本語。", str(run.call_args.args[0]))

    def test_partial_audio_counts_toward_the_same_quota_as_legacy_audio_and_memos(self):
        job = self.queued()
        with patch(
            "capture.narration_provider.synthesize",
            side_effect=[PCM, narration_provider.ProviderFailure("provider_rejected")],
        ):
            narration.work_once()
        self.assertEqual(job.segments.first().size_bytes, len(PCM))
        with (
            override_settings(MAX_PRIVATE_BYTES_PER_USER=len(PCM)),
            self.assertRaises(services.Conflict),
        ):
            services.check_quota(self.owner, added_bytes=1)

    @override_settings(TTS_USER_ACTIVE_JOBS=1)
    def test_legacy_admission_cannot_ignore_an_active_long_narration(self):
        self.queued()
        document = services.create_document(
            self.owner, {"title": "短い資料", "text": "短い日本語。"}
        )
        with self.assertRaises(services.Conflict):
            generation.enqueue(
                self.owner, document.id, document.versions.first().id, uuid.uuid4()
            )

    def test_legacy_and_long_narration_share_one_utc_budget(self):
        document = services.create_document(
            self.owner, {"title": "短い資料", "text": "短い日本語。"}
        )
        version = document.versions.first()
        generation.enqueue(self.owner, document.id, version.id, uuid.uuid4())
        self.queued()
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved,
            len(version.text) + len(self.text),
        )

    def test_polly_pcm_request_contract_is_mocked_without_spending(self):
        stream = io.BytesIO(PCM)
        with patch("capture.narration_provider.boto3.client") as client:
            client.return_value.synthesize_speech.return_value = {"AudioStream": stream}
            self.assertEqual(narration_provider._polly_pcm("日本語。"), PCM)
        self.assertTrue(stream.closed)
        self.assertEqual(
            client.call_args.kwargs["config"].retries["total_max_attempts"], 1
        )
        client.return_value.synthesize_speech.assert_called_once_with(
            Text="日本語。",
            TextType="text",
            OutputFormat="pcm",
            SampleRate="16000",
            VoiceId="Mizuki",
            LanguageCode="ja-JP",
            Engine="standard",
        )

    def test_final_publish_retry_needs_no_provider_approval_or_new_character_budget(
        self,
    ):
        job = self.queued()
        with (
            patch("capture.narration_provider.synthesize", return_value=PCM),
            patch(
                "capture.narration._publish",
                side_effect=narration_provider.ProviderFailure("storage_failed"),
            ),
        ):
            narration.work_once()
        self.assertFalse(job.segments.exclude(state="succeeded").exists())
        with override_settings(LC_E2E_FIXTURE_TTS=False):
            self.assertEqual(self.retry(job).status_code, 202)
            with patch("capture.narration_provider.synthesize") as synth:
                narration.work_once()
            synth.assert_not_called()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved, len(self.text)
        )


@override_settings(**FIXTURE)
class NarrationWindowsTests(NarrationSetup, TransactionTestCase):
    @skipUnless(
        os.name == "nt" and os.environ.get("LC_TEST_REAL_WINDOWS_TTS") == "1",
        "Separate explicit installed Windows voice integration",
    )
    @override_settings(DEBUG=True, LC_LOCAL_WINDOWS_TTS=True, LC_E2E_FIXTURE_TTS=False)
    def test_real_windows_japanese_runs_through_http_queue_worker_and_private_audio(
        self,
    ):
        document = services.create_document(
            self.owner,
            {
                "title": "日本語の実生成",
                "text": "これは開発用の日本語音声です。音声メモと資料の位置を確認します。",
            },
        )
        response = self.client.post(
            f"/api/documents/{document.id}/narration/",
            {
                "document_version": str(document.versions.first().id),
                "client_id": str(uuid.uuid4()),
                "provider": "windows",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 202, response.data)
        call_command("narration_worker", once=True)
        result = self.client.get(f"/api/narrations/{response.data['id']}/")
        self.assertEqual(result.data["state"], "succeeded", result.data)
        audio = AudioVersion.objects.get(pk=result.data["audio_version"])
        self.assertEqual(audio.kind, "windows")
        self.assertGreater(audio.duration_ms, 1000)
        response = self.client.get(f"/api/audio/{audio.id}/content/")
        self.assertEqual(response.status_code, 200)
        data = b"".join(response.streaming_content)
        with wave.open(io.BytesIO(data)) as sound:
            self.assertEqual(sound.getframerate(), 16000)
            self.assertTrue(any(sound.readframes(sound.getnframes())))


@override_settings(**FIXTURE)
class NarrationConcurrencyTests(NarrationSetup, TransactionTestCase):
    @override_settings(LC_LOCAL_WINDOWS_TTS=True)
    def test_windows_discovery_does_not_run_while_account_or_job_rows_are_locked(self):
        job = self.queued()
        job.provider = "windows"
        job.save(update_fields=["provider"])

        def installed():
            self.assertFalse(connection.in_atomic_block)
            return True

        with (
            patch(
                "capture.narration_provider.installed_windows_voice",
                side_effect=installed,
            ) as probe,
            patch("capture.narration_provider.synthesize", return_value=PCM),
        ):
            narration.work_once()
        self.assertGreater(probe.call_count, 0)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")

    def test_provider_and_storage_io_run_outside_database_transactions(self):
        self.queued()
        original_put, original_read = storage.put_bytes, storage.read_bytes

        def put(*args, **kwargs):
            self.assertFalse(connection.in_atomic_block)
            return original_put(*args, **kwargs)

        def read(*args, **kwargs):
            self.assertFalse(connection.in_atomic_block)
            return original_read(*args, **kwargs)

        def synthesize(*args):
            self.assertFalse(connection.in_atomic_block)
            return PCM

        with (
            patch("capture.narration_provider.synthesize", side_effect=synthesize),
            patch("capture.narration.storage.put_bytes", side_effect=put),
            patch("capture.narration.storage.read_bytes", side_effect=read),
        ):
            narration.work_once()
        self.assertEqual(NarrationJob.objects.get().state, "succeeded")

    def test_concurrent_first_requests_share_one_job_and_whole_text_reservation(self):
        barrier = Barrier(2)

        def submit(_):
            close_old_connections()
            try:
                owner = get_user_model().objects.get(pk=self.owner.pk)
                barrier.wait(timeout=10)
                job, created = narration.enqueue(
                    owner, self.document.id, self.version.id, uuid.uuid4(), "fixture"
                )
                return job.pk, created
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertEqual(results[0][0], results[1][0])
        self.assertEqual(sorted(result[1] for result in results), [False, True])
        self.assertEqual(
            GlobalTtsBudget.objects.get().characters_reserved, len(self.text)
        )
