"""VOICEVOX contracts with HTTP stubs and isolated PostgreSQL; no engine/AWS."""

import io
import json
import subprocess
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
import wave

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from rest_framework.exceptions import ValidationError
from rest_framework.test import APIClient

from capture import (
    narration,
    narration_provider,
    services,
    voicevox_provider as voicevox,
)
from capture.models import (
    AudioVersion,
    GlobalTtsBudget,
    TtsCapacityReservation,
    UserTtsBudget,
)
from capture.narration_models import NarrationJob, NarrationRequest, NarrationSegment
from capture.tests.test_narration import FIXTURE

VOICE = {"speaker_id": 14, "pitch_scale": 0.0}
CATALOG = {
    "engine_version": "0.25.2",
    "core_version": "0.15.0",
    "voices": [
        {
            "id": 14,
            "name": "テスト話者",
            "style": "ノーマル",
            "credit": "VOICEVOX:テスト話者",
            "speaker_uuid": "synthetic-character",
            "speaker_version": "1.0",
        }
    ],
}


def wav(*, rate=16000, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as sound:
        sound.setnchannels(channels)
        sound.setsampwidth(width)
        sound.setframerate(rate)
        sound.writeframes(
            b"\x01\x00" * (rate // 10) * channels
            if width == 2
            else b"\x01" * (rate // 10) * channels
        )
    return output.getvalue()


@override_settings(VOICEVOX_ENABLED=True, VOICEVOX_BASE_URL="http://127.0.0.1:50021")
class VoicevoxProviderContractTests(SimpleTestCase):
    def setUp(self):
        voicevox._catalog_cache = None
        self.addCleanup(setattr, voicevox, "_catalog_cache", None)

    def test_disabled_default_has_no_engine_requests(self):
        with (
            override_settings(VOICEVOX_ENABLED=False),
            patch.object(voicevox, "_request") as request,
        ):
            self.assertFalse(voicevox.configuration()["enabled"])
            with self.assertRaises(narration_provider.ProviderFailure):
                voicevox.synthesize("本文", {})
        request.assert_not_called()

    def test_missing_configured_default_selects_an_installed_voice_without_disabling_other_providers(
        self,
    ):
        alternate = CATALOG | {"voices": [CATALOG["voices"][0] | {"id": 3}]}
        with patch.object(voicevox, "catalog", return_value=alternate):
            result = narration_provider.configuration()
        option = next(item for item in result["providers"] if item["id"] == "voicevox")
        self.assertTrue(option["enabled"])
        self.assertEqual(option["defaults"], {"speaker_id": 3, "pitch_scale": 0.0})
        self.assertEqual(
            {item["id"] for item in result["providers"]},
            {"polly", "windows", "fixture", "voicevox"},
        )

    def test_unreachable_catalog_disables_only_VOICEVOX(self):
        with patch.object(
            voicevox,
            "catalog",
            side_effect=narration_provider.ProviderFailure("provider_unavailable"),
        ):
            result = narration_provider.configuration()
        self.assertFalse(
            next(item for item in result["providers"] if item["id"] == "voicevox")[
                "enabled"
            ]
        )
        self.assertEqual(len(result["providers"]), 4)

    def test_endpoint_rejects_redirect_targets_userinfo_and_external_hosts_before_HTTP(
        self,
    ):
        for address in (
            "https://127.0.0.1:50021",
            "http://169.254.169.254",
            "http://example.com",
            "http://user:pass@127.0.0.1",
            "http://127.0.0.1/path",
            "http://127.0.0.1?url=secret",
            "http://127.0.0.1#fragment",
        ):
            with (
                self.subTest(address=address),
                override_settings(VOICEVOX_BASE_URL=address),
                patch("http.client.HTTPConnection") as client,
            ):
                with self.assertRaises(narration_provider.ProviderFailure):
                    voicevox._request("GET", "/version")
                client.assert_not_called()
        with override_settings(VOICEVOX_BASE_URL="http://voicevox:50021"):
            self.assertEqual(voicevox.endpoint(), ("voicevox", 50021))

    def test_numeric_types_ranges_precision_and_unknown_fields_are_strict(self):
        self.assertEqual(
            voicevox.normalize_voice("voicevox", {"speaker_id": 14, "pitch_scale": 0}),
            VOICE,
        )
        for value in (
            None,
            True,
            {"speaker_id": True, "pitch_scale": 0},
            {"speaker_id": "14", "pitch_scale": 0},
            {"speaker_id": 14, "pitch_scale": float("nan")},
            {"speaker_id": 14, "pitch_scale": float("inf")},
            {"speaker_id": 14, "pitch_scale": 10**400},
            {"speaker_id": 14, "pitch_scale": 0.16},
            {"speaker_id": 14, "pitch_scale": -0.151},
            {"speaker_id": 14, "pitch_scale": 0.001},
            VOICE | {"engine_url": "http://elsewhere"},
        ):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                voicevox.normalize_voice("voicevox", value)
        with self.assertRaises(ValidationError):
            voicevox.normalize_voice("polly", VOICE)

    def test_catalog_filters_singing_and_keeps_engine_character_identity(self):
        responses = [
            b'"0.25.2"',
            b'["0.9.0","0.15.0"]',
            json.dumps(
                [
                    {
                        "name": "テスト話者",
                        "speaker_uuid": "id",
                        "version": "1.0",
                        "styles": [
                            {"id": 14, "name": "通常"},
                            {"id": 99, "name": "歌", "type": "sing"},
                            {"id": 15, "name": "新talk", "type": "streaming_talk"},
                        ],
                    }
                ]
            ).encode(),
        ]
        with patch.object(voicevox, "_request", side_effect=responses) as request:
            result = voicevox.catalog()
            self.assertEqual([item["id"] for item in result["voices"]], [14, 15])
            self.assertEqual(result["core_version"], "0.15.0")
            self.assertEqual(result["voices"][0]["credit"], "VOICEVOX:テスト話者")
            self.assertEqual(voicevox.catalog(), result)
        self.assertEqual(request.call_count, 3)

    def test_query_preserves_original_text_and_selects_16k_mono_request_local_pitch(
        self,
    ):
        profile = voicevox.synthesis_profile(
            VOICE | {"pitch_scale": 0.08}, available=CATALOG
        )
        calls = []

        def request(method, path, **kwargs):
            calls.append((method, path, kwargs))
            return b'{"accent_phrases":[]}' if path == "/audio_query" else wav()

        with (
            patch.object(voicevox, "catalog", return_value=CATALOG),
            patch.object(voicevox, "_request", side_effect=request),
        ):
            pcm = voicevox._pcm("忙しかった分、原文😀。", profile)
        self.assertEqual(len(pcm), 3200)
        self.assertEqual(calls[0][2]["query"]["text"], "忙しかった分、原文😀。")
        self.assertEqual(calls[1][2]["payload"]["pitchScale"], 0.08)
        self.assertEqual(calls[1][2]["payload"]["outputSamplingRate"], 16000)
        self.assertIs(calls[1][2]["payload"]["outputStereo"], False)
        self.assertEqual(
            calls[1][2]["query"], {"speaker": 14, "core_version": "0.15.0"}
        )

    def test_wrong_wav_format_truncation_or_engine_version_never_publishes_PCM(self):
        profile = voicevox.synthesis_profile(VOICE, available=CATALOG)
        for data in (
            b"RIFFbad",
            wav(rate=24000),
            wav(channels=2),
            wav(width=1),
            wav()[:-2],
        ):
            with (
                self.subTest(size=len(data)),
                patch.object(voicevox, "catalog", return_value=CATALOG),
                patch.object(voicevox, "_request", side_effect=[b"{}", data]),
            ):
                with self.assertRaises(narration_provider.ProviderFailure):
                    voicevox._pcm("本文", profile)
        with (
            patch.object(
                voicevox, "catalog", return_value=CATALOG | {"engine_version": "new"}
            ),
            patch.object(voicevox, "_request") as request,
        ):
            with self.assertRaises(narration_provider.ProviderFailure):
                voicevox._pcm("本文", profile)
        request.assert_not_called()

    def test_HTTP_never_retries_or_follows_redirect_and_response_is_bounded(self):
        with patch("http.client.HTTPConnection") as connection:
            client = connection.return_value
            client.getresponse.return_value = SimpleNamespace(status=302)
            with self.assertRaises(narration_provider.ProviderFailure):
                voicevox._request("GET", "/version")
            self.assertEqual(client.request.call_count, 1)
            client.close.assert_called_once()
        with patch("http.client.HTTPConnection") as connection:
            client = connection.return_value
            client.getresponse.return_value = SimpleNamespace(
                status=200, read=lambda size: b"x" * size
            )
            with self.assertRaises(narration_provider.ProviderFailure) as error:
                voicevox._request("GET", "/version", maximum=100)
            self.assertEqual(error.exception.code, "audio_invalid")

    def test_worker_hard_timeout_does_not_retry_or_fall_back_to_Polly(self):
        profile = voicevox.synthesis_profile(VOICE, available=CATALOG)
        with (
            patch(
                "capture.narration_provider._bounded_child",
                side_effect=subprocess.TimeoutExpired([], 120),
            ) as child,
            patch("capture.narration_provider.boto3.client") as aws,
        ):
            with self.assertRaises(narration_provider.ProviderFailure) as error:
                voicevox.synthesize("本文。", profile)
            self.assertEqual(error.exception.code, "execution_unknown")
        self.assertEqual(child.call_count, 1)
        self.assertEqual(child.call_args.kwargs["timeout"], 120)
        self.assertEqual(child.call_args.kwargs["env"]["POLLY_ENABLED"], "0")
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", child.call_args.kwargs["env"])
        aws.assert_not_called()

    def test_actual_HTTP_adapter_encodes_query_without_proxy_and_closes(self):
        with patch("http.client.HTTPConnection") as connection:
            client = connection.return_value
            client.getresponse.return_value = SimpleNamespace(
                status=200, read=lambda _: b"{}"
            )
            voicevox._request(
                "POST", "/audio_query", query={"text": "原文😀", "speaker": 14}
            )
            args = client.request.call_args.args
            self.assertEqual(parse_qs(urlsplit(args[1]).query)["text"], ["原文😀"])
            self.assertEqual(connection.call_args.args, ("127.0.0.1", 50021))
            client.close.assert_called_once()


@override_settings(**FIXTURE, VOICEVOX_ENABLED=True)
class VoicevoxNarrationTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.directory = tempfile.TemporaryDirectory()
        self.private_media = override_settings(
            PRIVATE_MEDIA_ROOT=Path(self.directory.name)
        )
        self.private_media.enable()
        self.addCleanup(self.private_media.disable)
        self.addCleanup(self.directory.cleanup)
        self.owner = get_user_model().objects.create_user("voicevox-owner")
        self.other = get_user_model().objects.create_user("voicevox-other")
        self.document = services.create_document(
            self.owner, {"title": "声の設定", "text": "原文の確認。"}
        )
        self.version = self.document.versions.first()
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self.url = f"/api/documents/{self.document.pk}/narration/"
        self.catalog_patch = patch.object(voicevox, "catalog", return_value=CATALOG)
        self.catalog = self.catalog_patch.start()
        self.addCleanup(self.catalog_patch.stop)

    def start(self, key=None, voice=None):
        return self.client.post(
            self.url,
            {
                "document_version": str(self.version.pk),
                "client_id": str(key or uuid.uuid4()),
                "provider": "voicevox",
                "voice": VOICE if voice is None else voice,
            },
            format="json",
        )

    def test_uuid_replay_uses_original_profile_even_disabled_and_pitch_change_conflicts(
        self,
    ):
        key = uuid.uuid4()
        original = self.start(key)
        self.assertEqual(original.status_code, 202, original.data)
        with (
            override_settings(VOICEVOX_ENABLED=False, VOICEVOX_SPEAKER_ID=3),
            patch.object(
                voicevox,
                "catalog",
                side_effect=AssertionError("must replay before catalog"),
            ),
        ):
            replay = self.start(key)
            changed = self.start(key, VOICE | {"pitch_scale": 0.01})
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.data["id"], original.data["id"])
        self.assertEqual(changed.status_code, 409)

    def test_invalid_voice_JSON_is_400_before_engine_budget_or_database_changes(self):
        models = (
            NarrationJob,
            NarrationRequest,
            NarrationSegment,
            AudioVersion,
            TtsCapacityReservation,
            GlobalTtsBudget,
            UserTtsBudget,
        )
        before = [model.objects.count() for model in models]
        payload = {
            "document_version": str(self.version.pk),
            "client_id": str(uuid.uuid4()),
            "provider": "voicevox",
        }
        for fields in (
            {},
            {"voice": None},
            {"voice": True},
            {"voice": VOICE | {"speaker_id": True}},
            {"voice": VOICE | {"pitch_scale": True}},
            {"voice": VOICE | {"pitch_scale": 10**400}},
        ):
            with self.subTest(fields=fields):
                response = self.client.post(self.url, payload | fields, format="json")
                self.assertEqual(response.status_code, 400, response.data)
                self.assertEqual([model.objects.count() for model in models], before)
        self.catalog.assert_not_called()

    def test_new_pitch_gets_distinct_job_but_same_profile_reuses_and_keeps_budgets(
        self,
    ):
        first = self.start()
        with patch.object(voicevox, "synthesize", return_value=b"\x01\x00" * 1600):
            self.assertTrue(narration.work_once())
        original = NarrationJob.objects.get(pk=first.data["id"])
        self.assertEqual(original.state, "succeeded")
        self.assertEqual(
            original.audio_version.synthesis_profile, original.synthesis_profile
        )
        second = self.start(voice=VOICE | {"pitch_scale": 0.01})
        reused = self.start()
        self.assertEqual(
            (first.status_code, second.status_code, reused.status_code), (202, 202, 200)
        )
        self.assertNotEqual(first.data["id"], second.data["id"])
        self.assertEqual(first.data["id"], reused.data["id"])
        self.assertEqual(TtsCapacityReservation.objects.count(), 1)

    def test_publication_retry_retains_PCM_profile_without_engine_or_new_provider_call(
        self,
    ):
        result = self.start()
        job = NarrationJob.objects.get(pk=result.data["id"])
        with (
            patch.object(voicevox, "synthesize", return_value=b"\x01\x00" * 1600),
            patch(
                "capture.narration._publish",
                side_effect=narration_provider.ProviderFailure("storage_failed"),
            ),
        ):
            narration.work_once()
        self.assertFalse(job.segments.exclude(state="succeeded").exists())
        with (
            override_settings(VOICEVOX_ENABLED=False),
            patch.object(
                voicevox, "synthesize", side_effect=AssertionError("PCM must be reused")
            ),
        ):
            retried = self.client.post(
                f"/api/narrations/{job.pk}/retry/",
                {"client_id": str(uuid.uuid4())},
                format="json",
            )
            self.assertEqual(retried.status_code, 202, retried.data)
            narration.work_once()
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        self.assertEqual(job.audio_version.synthesis_profile, job.synthesis_profile)

    def test_foreign_parent_is_rejected_before_engine_request_and_unknown_voice_is_400(
        self,
    ):
        self.client.force_authenticate(self.other)
        self.assertEqual(self.start().status_code, 404)
        self.catalog.assert_not_called()
        self.client.force_authenticate(self.owner)
        self.assertEqual(self.start(voice=VOICE | {"speaker_id": 999}).status_code, 400)
        self.assertEqual(NarrationJob.objects.count(), 0)

    def test_db_profile_immutability_and_audio_provenance_survives_job_deletion(self):
        response = self.start()
        job = NarrationJob.objects.get(pk=response.data["id"])
        with transaction.atomic(), self.assertRaises(IntegrityError):
            NarrationJob.objects.filter(pk=job.pk).update(
                voice_settings=VOICE | {"pitch_scale": 0.01}
            )
        audio = AudioVersion.objects.create(
            document_version=self.version,
            kind="voicevox",
            storage_key="synthetic-voicevox-not-a-real-object",
            duration_ms=1000,
            synthesis_profile=job.synthesis_profile,
        )
        with transaction.atomic(), self.assertRaises(IntegrityError):
            AudioVersion.objects.filter(pk=audio.pk).update(synthesis_profile={})
        profile = job.synthesis_profile
        job.delete()
        audio.refresh_from_db()
        self.assertEqual(audio.synthesis_profile, profile)

    def test_existing_fixture_and_Polly_payloads_stay_compatible(self):
        result = self.client.post(
            self.url,
            {
                "document_version": str(self.version.pk),
                "client_id": str(uuid.uuid4()),
                "provider": "fixture",
            },
            format="json",
        )
        self.assertEqual(result.status_code, 202, result.data)
        job = NarrationJob.objects.get(pk=result.data["id"])
        self.assertEqual(job.synthesis_profile, {})
        self.assertEqual(job.profile_hash, voicevox.EMPTY_PROFILE_HASH)
