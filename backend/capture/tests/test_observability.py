from contextlib import contextmanager
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import tempfile
import threading
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from capture import storage
from capture.health_probe import probe_loopback
from capture.middleware import RequestLogMiddleware
from capture.models import PdfImport
from capture.observability import JsonFormatter, storage_health


class RequestObservationTests(SimpleTestCase):
    def test_json_request_id_latency_and_status_omit_private_inputs(self):
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        handler.setFormatter(JsonFormatter())
        logger = logging.getLogger("capture.requests")
        original = logger.handlers
        logger.handlers = [handler]
        self.addCleanup(setattr, logger, "handlers", original)
        request = RequestFactory().post(
            "/api/private/secret-path?token=secret-query",
            {"password": "secret-body"},
            HTTP_COOKIE="sessionid=secret-cookie",
            HTTP_X_REQUEST_ID="forged-secret-id",
        )
        response = RequestLogMiddleware(lambda _: HttpResponse(status=503))(request)
        line = output.getvalue()
        record = json.loads(line)
        self.assertEqual(record["request_id"], response["X-Request-ID"])
        self.assertRegex(record["request_id"], r"^[a-f0-9]{32}$")
        self.assertEqual(record["event"], "http_request")
        self.assertEqual(record["status"], 503)
        self.assertEqual(record["scope"], "api")
        self.assertGreaterEqual(record["elapsed_ms"], 0)
        self.assertEqual(line.count("\n"), 1)
        self.assertNotIn("secret", line)
        self.assertNotIn("private/", line)


class HealthProbeContractTests(TestCase):
    def test_probe_consumes_real_health_view_and_database_failure_responses(self):
        healthy = self.client.get("/api/health/")
        with patch(
            "capture.views.connection.cursor",
            side_effect=RuntimeError("private-db-failure"),
        ):
            unavailable = self.client.get("/api/health/")
        self.assertEqual(healthy.status_code, 200)
        self.assertEqual(unavailable.status_code, 503)
        self.assertNotIn(b"private-db-failure", unavailable.content)
        for response in (healthy, unavailable):
            with health_response_server(response) as origin:
                observed = probe_loopback(origin)
            self.assertEqual(observed["status"], response.status_code)
            self.assertEqual(observed["healthy"], response.status_code == 200)


@contextmanager
def health_response_server(response):
    """Serve the real view's bytes without importing host scripts into the image."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(response.status_code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response.content)

        def log_message(self, *arguments):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
    )
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=1)


class StorageObservationTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting = override_settings(
            PRIVATE_STORAGE_BACKEND="local", PRIVATE_MEDIA_ROOT=Path(directory.name)
        )
        setting.enable()
        self.addCleanup(setting.disable)
        self.owner = get_user_model().objects.create_user("observability-owner")

    def source(self):
        key = storage.put_bytes(b"private-source", "pdf")
        PdfImport.objects.create(
            owner=self.owner,
            client_id=uuid.uuid4(),
            payload_digest="a" * 64,
            suggested_title="Private title never reported",
            storage_key=key,
            source_size_bytes=14,
            expires_at=timezone.now() + timedelta(days=1),
        )
        return key

    def test_missing_changed_objects_and_disk_pressure_are_unhealthy_without_keys(self):
        key = self.source()
        good = storage_health(minimum_free_bytes=0)
        self.assertTrue(good["healthy"])
        storage.path_for(key).write_bytes(b"changed")
        self.assertEqual(storage_health(minimum_free_bytes=0)["size_mismatches"], 1)
        storage.path_for(key).unlink()
        missing = storage_health(minimum_free_bytes=0)
        self.assertEqual(missing["missing_objects"], 1)
        self.assertFalse(missing["healthy"])
        self.assertNotIn(key, json.dumps(missing))
        with patch(
            "capture.observability.shutil.disk_usage",
            return_value=type("Disk", (), {"free": 1})(),
        ):
            self.assertFalse(storage_health(minimum_free_bytes=2)["healthy"])

    def test_inventory_limit_and_unapproved_s3_refuse_before_object_access(self):
        self.source()
        self.source()
        with patch("capture.storage.stat") as stat:
            self.assertEqual(storage_health(max_objects=1)["error"], "inventory_limit")
            stat.assert_not_called()
        with (
            override_settings(PRIVATE_STORAGE_BACKEND="s3"),
            patch("capture.storage.stat") as stat,
        ):
            self.assertEqual(
                storage_health()["error"], "storage_or_database_unavailable"
            )
            stat.assert_not_called()

    def test_approved_s3_checks_bounded_heads_scratch_disk_and_hides_provider_details(
        self,
    ):
        from .test_storage import S3_SETTINGS

        key = self.source()
        item = storage.StorageObject(key, 14, timezone.now())
        with (
            override_settings(**S3_SETTINGS),
            patch("capture.storage.stat", return_value=item) as stat,
        ):
            good = storage_health(minimum_free_bytes=0)
            self.assertTrue(good["healthy"])
            stat.assert_called_once_with(key)
            self.assertNotIn(key, json.dumps(good))
        with (
            override_settings(**S3_SETTINGS),
            patch(
                "capture.storage.stat",
                side_effect=storage.StorageMissing("private-object-key"),
            ),
        ):
            self.assertEqual(storage_health(minimum_free_bytes=0)["missing_objects"], 1)
        with (
            override_settings(**S3_SETTINGS),
            patch(
                "capture.storage.stat",
                side_effect=storage.StorageUnavailable("private-bucket-provider-error"),
            ),
        ):
            observed = storage_health(minimum_free_bytes=0)
            self.assertFalse(observed["healthy"])
            self.assertEqual(observed["error"], "storage_or_database_unavailable")
            self.assertNotIn("private-bucket-provider-error", json.dumps(observed))
