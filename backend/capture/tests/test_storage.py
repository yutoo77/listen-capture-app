"""Portable private object and authorized proxy tests; S3 is SDK-stubbed only."""

from datetime import datetime, timezone
import io
import os
from pathlib import Path
import tempfile
import uuid
from unittest.mock import patch

import boto3
from botocore.response import StreamingBody
from botocore.stub import Stubber
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient

from capture import storage
from capture.models import AudioVersion, Document, DocumentVersion

NOW = datetime(2026, 10, 18, tzinfo=timezone.utc)
S3_SETTINGS = {
    "PRIVATE_STORAGE_BACKEND": "s3",
    "PRIVATE_S3_USE_APPROVED": True,
    "PRIVATE_S3_BUCKET": "synthetic-private-bucket",
    "PRIVATE_S3_EXPECTED_OWNER": "123456789012",
    "PRIVATE_S3_PREFIX": "private/v1/",
    "PRIVATE_S3_REGION": "ap-northeast-1",
}
KEY = "aa/synthetic.wav"
PARAMS = {
    "Bucket": "synthetic-private-bucket",
    "ExpectedBucketOwner": "123456789012",
    "Key": "private/v1/" + KEY,
}


class LocalStorageTests(SimpleTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.setting = override_settings(
            PRIVATE_STORAGE_BACKEND="local", PRIVATE_MEDIA_ROOT=Path(folder.name)
        )
        self.setting.enable()
        self.addCleanup(self.setting.disable)

    def test_local_roundtrip_ranges_bounds_listing_and_delete(self):
        key = storage.put_bytes(b"0123456789", "wav")
        self.assertEqual(storage.stat(key).size_bytes, 10)
        with storage.open_read(key, start=3, length=4) as source:
            self.assertEqual(source.read(100), b"3456")
            self.assertEqual(source.read(), b"")
        self.assertEqual(storage.read_bytes(key, max_bytes=10), b"0123456789")
        with self.assertRaises(storage.StorageUnavailable):
            storage.read_bytes(key, max_bytes=9)
        self.assertEqual([item.key for item in storage.objects()], [key])
        self.assertTrue(storage.delete_key(key))
        with self.assertRaises(storage.StorageMissing):
            storage.stat(key)

    def test_keys_suffix_and_oversized_writes_are_rejected_before_storage(self):
        for key in ("../x", "/absolute", "aa/../x", "aa//x", "aa\\x", "C:/x", "aa/./x"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                storage.path_for(key)
        with self.assertRaises(ValueError):
            storage.put_bytes(b"x", "../wav")
        with override_settings(PRIVATE_STORAGE_MAX_OBJECT_BYTES=2):
            with self.assertRaises(storage.StorageUnavailable):
                storage.put_bytes(b"xxx", "wav")


class S3EndpointTests(SimpleTestCase):
    def test_environment_endpoint_cannot_redirect_private_objects_or_disable_tls(self):
        environment = {
            "AWS_ACCESS_KEY_ID": "synthetic",
            "AWS_SECRET_ACCESS_KEY": "synthetic",
            "AWS_SESSION_TOKEN": "synthetic",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_ENDPOINT_URL": "http://untrusted.invalid",
            "AWS_ENDPOINT_URL_S3": "http://untrusted.invalid",
        }
        storage._client.cache_clear()
        self.addCleanup(storage._client.cache_clear)
        with patch.dict(os.environ, environment):
            # Client construction only: explicit synthetic credentials and no SDK calls.
            client = storage._client("ap-northeast-1")
        self.addCleanup(client.close)
        self.assertEqual(
            client.meta.endpoint_url, "https://s3.ap-northeast-1.amazonaws.com"
        )
        self.assertTrue(client._endpoint.http_session._verify)

    @override_settings(
        **(S3_SETTINGS | {"PRIVATE_S3_REGION": "http://untrusted.invalid"})
    )
    def test_invalid_region_refused_before_creating_client(self):
        with patch("capture.storage._client") as client:
            with self.assertRaises(storage.StorageUnavailable):
                storage.stat(KEY)
            client.assert_not_called()


@override_settings(**S3_SETTINGS)
class S3StorageTests(SimpleTestCase):
    def setUp(self):
        # Explicit synthetic credentials plus Stubber: no credential lookup,
        # metadata access, endpoint traffic, buckets or billable SDK request.
        self.client = boto3.client(
            "s3",
            region_name="ap-northeast-1",
            aws_access_key_id="synthetic",
            aws_secret_access_key="synthetic",
        )
        self.stub = Stubber(self.client)
        self.stub.activate()
        self.addCleanup(self.stub.deactivate)
        self.client_patch = patch("capture.storage._client", return_value=self.client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)

    def test_conditional_encrypted_write_has_no_acl_and_delete_is_private(self):
        key = "ab/" + "c" * 32 + ".wav"
        self.stub.add_response(
            "put_object",
            {},
            {
                "Bucket": PARAMS["Bucket"],
                "ExpectedBucketOwner": PARAMS["ExpectedBucketOwner"],
                "Key": "private/v1/" + key,
                "Body": b"test",
                "ContentLength": 4,
                "ContentType": "application/octet-stream",
                "ServerSideEncryption": "AES256",
                "IfNoneMatch": "*",
                "Metadata": {
                    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
                },
            },
        )
        self.stub.add_response(
            "delete_object", {}, {**PARAMS, "Key": "private/v1/" + key}
        )
        with patch(
            "capture.storage.uuid.uuid4",
            side_effect=[uuid.UUID("ab" + "0" * 30), uuid.UUID("c" * 32)],
        ):
            self.assertEqual(storage.put_bytes(b"test", "wav"), key)
        self.assertTrue(storage.delete_key(key))
        self.stub.assert_no_pending_responses()

    def test_head_and_range_use_expected_owner_and_etag_and_close(self):
        self.stub.add_response(
            "head_object",
            {"ContentLength": 10, "LastModified": NOW, "ETag": '"v1"'},
            PARAMS,
        )
        body = StreamingBody(io.BytesIO(b"3456"), 4)
        self.stub.add_response(
            "get_object",
            {"ContentLength": 4, "Body": body},
            {**PARAMS, "Range": "bytes=3-6", "IfMatch": '"v1"'},
        )
        item = storage.stat(KEY)
        with storage.open_read(KEY, start=3, length=4, etag=item.etag) as source:
            self.assertEqual(source.read(), b"3456")
        self.assertTrue(body._raw_stream.closed)
        self.stub.assert_no_pending_responses()

    def test_remote_error_is_sanitized_and_failed_delete_remains_observable(self):
        self.stub.add_client_error(
            "head_object",
            service_error_code="AccessDenied",
            service_message="secret-provider-detail",
            expected_params=PARAMS,
        )
        with self.assertRaises(storage.StorageUnavailable) as error:
            storage.stat(KEY)
        self.assertNotIn("secret-provider-detail", str(error.exception))
        self.stub.add_client_error(
            "delete_object", service_error_code="AccessDenied", expected_params=PARAMS
        )
        with self.assertLogs("capture.storage", level="ERROR") as logs:
            self.assertFalse(storage.delete_key(KEY))
        self.assertNotIn(KEY, " ".join(logs.output))

    def test_missing_and_read_limit_do_not_fetch_body(self):
        self.stub.add_client_error(
            "head_object", service_error_code="404", expected_params=PARAMS
        )
        with self.assertRaises(storage.StorageMissing):
            storage.stat(KEY)
        self.stub.add_response(
            "head_object", {"ContentLength": 20, "LastModified": NOW}, PARAMS
        )
        with self.assertRaises(storage.StorageUnavailable):
            storage.read_bytes(KEY, max_bytes=10)
        self.stub.assert_no_pending_responses()

    def test_listing_pages_are_prefix_scoped(self):
        base = {
            "Bucket": PARAMS["Bucket"],
            "ExpectedBucketOwner": PARAMS["ExpectedBucketOwner"],
            "Prefix": "private/v1/",
            "MaxKeys": 1000,
        }
        self.stub.add_response(
            "list_objects_v2",
            {
                "IsTruncated": True,
                "NextContinuationToken": "next",
                "Contents": [
                    {"Key": "private/v1/" + KEY, "Size": 10, "LastModified": NOW}
                ],
            },
            base,
        )
        self.stub.add_response(
            "list_objects_v2",
            {
                "IsTruncated": False,
                "Contents": [
                    {"Key": "private/v1/bb/another.pcm", "Size": 2, "LastModified": NOW}
                ],
            },
            base | {"ContinuationToken": "next"},
        )
        self.assertEqual(
            [item.key for item in storage.objects()], [KEY, "bb/another.pcm"]
        )
        self.stub.assert_no_pending_responses()

    def test_disabled_or_invalid_s3_configuration_never_constructs_client(self):
        for change in (
            {"PRIVATE_S3_USE_APPROVED": False},
            {"PRIVATE_S3_EXPECTED_OWNER": ""},
            {"PRIVATE_S3_PREFIX": "../outside/"},
            {"PRIVATE_S3_BUCKET": "https://example.org"},
        ):
            with (
                self.subTest(setting=list(change)),
                override_settings(**change),
                patch("capture.storage._client") as client,
            ):
                with self.assertRaises(storage.StorageUnavailable):
                    storage.stat(KEY)
                client.assert_not_called()


@override_settings(**S3_SETTINGS)
class PrivateProxyTests(TransactionTestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user("storage-owner")
        self.other = get_user_model().objects.create_user("storage-other")
        document = Document.objects.create(owner=self.owner, title="Private")
        version = DocumentVersion.objects.create(
            document=document, number=1, text="Private body"
        )
        self.audio = AudioVersion.objects.create(
            document_version=version,
            kind="demo",
            storage_key=KEY,
            content_type="audio/wav",
            duration_ms=1000,
            size_bytes=10,
        )
        self.url = f"/api/audio/{self.audio.id}/content/"
        self.browser = APIClient()
        self.metadata = storage.StorageObject(KEY, 10, NOW, '"version"')

    def test_anonymous_and_other_owner_never_touch_object_storage(self):
        with patch("capture.storage.stat") as stat:
            self.assertEqual(self.browser.get(self.url).status_code, 403)
            self.browser.force_authenticate(self.other)
            self.assertEqual(self.browser.get(self.url).status_code, 404)
            stat.assert_not_called()

    def test_head_and_invalid_range_never_fetch_body(self):
        self.browser.force_authenticate(self.owner)
        with (
            patch("capture.storage.stat", return_value=self.metadata),
            patch("capture.storage.open_read") as opened,
        ):
            response = self.browser.head(self.url, HTTP_RANGE="bytes=2-4")
            self.assertEqual(
                (response.status_code, response["Content-Length"]), (206, "3")
            )
            self.assertEqual(
                self.browser.get(self.url, HTTP_RANGE="bytes=99-100").status_code, 416
            )
            opened.assert_not_called()

    def test_range_is_bounded_and_closes_even_before_consumption(self):
        self.browser.force_authenticate(self.owner)
        source = storage._BoundedReader(io.BytesIO(b"234"), 3)
        with (
            patch("capture.storage.stat", return_value=self.metadata),
            patch("capture.storage.open_read", return_value=source) as opened,
        ):
            response = self.browser.get(self.url, HTTP_RANGE="bytes=2-4")
            self.assertEqual(response["Content-Range"], "bytes 2-4/10")
            opened.assert_called_once_with(KEY, start=2, length=3, etag='"version"')
            response.close()
            self.assertTrue(source.closed)

    def test_storage_failure_is_retryable_and_does_not_expose_provider_data(self):
        self.browser.force_authenticate(self.owner)
        with patch(
            "capture.storage.stat",
            side_effect=storage.StorageUnavailable("internal bucket secret"),
        ):
            response = self.browser.get(self.url)
        self.assertEqual((response.status_code, response["Retry-After"]), (503, "5"))
        self.assertNotIn("internal bucket secret", str(response.data))
