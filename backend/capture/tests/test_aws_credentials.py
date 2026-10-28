"""Configuration and SDK contract tests only, with synthetic credentials."""

import io
from unittest.mock import patch

import boto3
from botocore.response import StreamingBody
from botocore.stub import Stubber
from django.test import SimpleTestCase, override_settings

from capture.aws_credentials import validate_instance_role_environment
from capture import narration_provider, polly
from capture.generation import GenerationFailure

ROLE = {
    "AWS_EC2_METADATA_DISABLED": "false",
    "AWS_EC2_METADATA_V1_DISABLED": "true",
    "AWS_CONFIG_FILE": "/dev/null",
    "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
    "BOTO_CONFIG": "/dev/null",
}
REQUEST = dict(
    Text="日本語",
    TextType="text",
    VoiceId="Mizuki",
    LanguageCode="ja-JP",
    Engine="standard",
)


class InstanceRoleConfigurationTests(SimpleTestCase):
    def test_valid_role_environment_is_checked_without_sdk_or_metadata(self):
        with patch("boto3.client") as client:
            validate_instance_role_environment(ROLE)
            client.assert_not_called()

    def test_static_session_web_identity_container_and_profile_sources_are_refused(
        self,
    ):
        for key in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_SECURITY_TOKEN",
            "AWS_CREDENTIAL_FILE",
            "AWS_PROFILE",
            "AWS_DEFAULT_PROFILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
            "AWS_ROLE_ARN",
            "AWS_ROLE_SESSION_NAME",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN",
            "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT",
            "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
        ):
            with self.subTest(key=key), self.assertRaises(RuntimeError) as error:
                validate_instance_role_environment(
                    ROLE | {key: "synthetic-private-value"}
                )
            self.assertNotIn("synthetic-private-value", str(error.exception))

    def test_metadata_disabled_v1_fallback_or_local_credential_files_are_refused(self):
        for key, value in (
            ("AWS_EC2_METADATA_DISABLED", "true"),
            ("AWS_EC2_METADATA_DISABLED", ""),
            ("AWS_EC2_METADATA_V1_DISABLED", "false"),
            ("AWS_EC2_METADATA_V1_DISABLED", ""),
            ("AWS_CONFIG_FILE", "/home/app/.aws/config"),
            ("AWS_SHARED_CREDENTIALS_FILE", ""),
            ("BOTO_CONFIG", "/private.cfg"),
        ):
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                validate_instance_role_environment(ROLE | {key: value})


@override_settings(
    POLLY_ENABLED=True, POLLY_BILLING_APPROVED=True, LC_E2E_FIXTURE_TTS=False
)
class PollyOfflineContractTests(SimpleTestCase):
    def setUp(self):
        self.client = boto3.client(
            "polly",
            region_name="ap-northeast-1",
            aws_access_key_id="synthetic",
            aws_secret_access_key="synthetic",
            aws_session_token="synthetic",
        )
        self.addCleanup(self.client.close)
        self.stub = Stubber(self.client)
        self.stub.activate()
        self.addCleanup(self.stub.deactivate)

    def assert_safe_sdk_configuration(self, factory):
        self.assertIs(factory.call_args.kwargs["use_ssl"], True)
        self.assertIs(factory.call_args.kwargs["verify"], True)
        config = factory.call_args.kwargs["config"]
        self.assertIs(config.ignore_configured_endpoint_urls, True)
        self.assertEqual(config.retries["total_max_attempts"], 1)
        self.assertEqual(config.connect_timeout, 5)

    def test_narration_pcm_contract_is_one_standard_japanese_request(self):
        body = StreamingBody(io.BytesIO(b"\x01\x00"), 2)
        self.stub.add_response(
            "synthesize_speech",
            {"AudioStream": body},
            REQUEST | {"OutputFormat": "pcm", "SampleRate": "16000"},
        )
        with patch(
            "capture.narration_provider.boto3.client", return_value=self.client
        ) as factory:
            self.assertEqual(narration_provider._polly_pcm("日本語"), b"\x01\x00")
            self.assert_safe_sdk_configuration(factory)
        self.assertTrue(body._raw_stream.closed)
        self.stub.assert_no_pending_responses()

    def test_legacy_mp3_contract_is_one_standard_japanese_request(self):
        body = StreamingBody(io.BytesIO(b"synthetic-mp3"), 13)
        # Stubber has no socket; keep the real StreamingBody length/close checks.
        timeout = patch.object(body, "set_socket_timeout")
        timeout.start()
        self.addCleanup(timeout.stop)
        self.stub.add_response(
            "synthesize_speech",
            {"AudioStream": body},
            REQUEST | {"OutputFormat": "mp3"},
        )
        with patch("capture.polly.boto3.client", return_value=self.client) as factory:
            self.assertEqual(
                polly.synthesize("日本語", "polly"),
                (b"synthetic-mp3", "audio/mpeg", "mp3"),
            )
            self.assert_safe_sdk_configuration(factory)
        self.assertTrue(body._raw_stream.closed)
        self.stub.assert_no_pending_responses()

    def test_iam_denial_is_sanitized_and_does_not_fallback(self):
        for legacy in (False, True):
            self.stub.add_client_error(
                "synthesize_speech",
                service_error_code="AccessDeniedException",
                service_message="private source must not appear",
                http_status_code=403,
                expected_params=REQUEST
                | (
                    {"OutputFormat": "mp3"}
                    if legacy
                    else {"OutputFormat": "pcm", "SampleRate": "16000"}
                ),
            )
            module = "capture.polly" if legacy else "capture.narration_provider"
            with (
                self.subTest(legacy=legacy),
                patch(module + ".boto3.client", return_value=self.client),
                self.assertRaises(
                    GenerationFailure if legacy else narration_provider.ProviderFailure
                ) as error,
            ):
                polly.synthesize(
                    "日本語", "polly"
                ) if legacy else narration_provider._polly_pcm("日本語")
            self.assertEqual(error.exception.code, "provider_rejected")
            self.assertNotIn("private source", str(error.exception))
        self.stub.assert_no_pending_responses()
