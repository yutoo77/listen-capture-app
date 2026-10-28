from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import io
from pathlib import Path
import tempfile
from threading import Barrier
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, close_old_connections, connections, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from pypdf import PdfReader, PdfWriter
from rest_framework.test import APIClient

from capture import pdf_imports, pdf_pages, pdf_sandbox
from capture.models import Document, PdfImport, PdfPageRequest
from capture.services import Conflict
from .test_pdf_imports import pdf_bytes


def numbered_pdf(pages):
    writer = PdfWriter()
    for number in range(1, pages + 1):
        writer.append(PdfReader(io.BytesIO(pdf_bytes(f"ONLY_PAGE_{number:03d}"))))
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


class PdfSelectedParserTests(TestCase):
    def test_real_200_page_source_requires_selection_and_extracts_only_selected_50(
        self,
    ):
        source = numbered_pdf(200)
        with self.assertRaises(pdf_sandbox.PdfFailure) as raised:
            pdf_sandbox.extract(source)
        self.assertEqual(raised.exception.code, "page_selection_required")
        self.assertEqual(raised.exception.page_count, 200)
        result = pdf_sandbox.extract(source, start_page=151, end_page=200)
        self.assertEqual(
            (result["page_count"], result["start_page"], result["end_page"]),
            (200, 151, 200),
        )
        self.assertIn("ONLY_PAGE_151", result["text"])
        self.assertIn("ONLY_PAGE_200", result["text"])
        self.assertNotIn("ONLY_PAGE_150", result["text"])
        self.assertNotIn("ONLY_PAGE_001", result["text"])
        self.assertEqual(len(result["text"].split("\n\n")), 50)

    def test_source_and_range_bounds_and_global_security_checks_survive_selection(self):
        with self.assertRaises(pdf_sandbox.PdfFailure) as raised:
            pdf_sandbox.extract(pdf_bytes(pages=201), start_page=1, end_page=1)
        self.assertEqual(raised.exception.code, "page_limit")
        source = numbered_pdf(3)
        for first, last in [(0, 1), (3, 2), (1, 51), (200, 201), (None, 2), (True, 2)]:
            with (
                self.subTest(first=first, last=last),
                self.assertRaises(pdf_sandbox.PdfFailure) as raised,
            ):
                pdf_sandbox.extract(source, start_page=first, end_page=last)
            self.assertEqual(raised.exception.code, "invalid_page_range")
        with self.assertRaises(pdf_sandbox.PdfFailure) as raised:
            pdf_sandbox.extract(source, start_page=3, end_page=4)
        self.assertEqual(raised.exception.code, "invalid_page_range")
        for option, code in [
            ("active", "active_content"),
            ("attachment", "active_content"),
            ("encrypted", "encrypted_pdf"),
        ]:
            with (
                self.subTest(option=option),
                self.assertRaises(pdf_sandbox.PdfFailure) as raised,
            ):
                pdf_sandbox.extract(
                    pdf_bytes(pages=2, **{option: True}), start_page=2, end_page=2
                )
            self.assertEqual(raised.exception.code, code)


class PageSetup:
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        settings = override_settings(
            PRIVATE_MEDIA_ROOT=Path(temporary.name),
            PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
        )
        settings.enable()
        self.addCleanup(settings.disable)
        self.owner = get_user_model().objects.create_user("page-owner")
        self.other = get_user_model().objects.create_user("page-other")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def upload(self, source=None):
        response = self.client.post(
            "/api/pdf-imports/",
            {
                "client_id": str(uuid.uuid4()),
                "file": SimpleUploadedFile(
                    "chapter.pdf",
                    source or numbered_pdf(3),
                    content_type="application/pdf",
                ),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 202, response.data)
        return PdfImport.objects.get(pk=response.data["id"])

    def known(self):
        job = self.upload()
        PdfImport.objects.filter(pk=job.pk).update(
            page_count=3, state="failed", error_code="page_selection_required"
        )
        job.refresh_from_db()
        return job

    def select(self, job, first=2, last=3, revision=0, key=None):
        return self.client.post(
            f"/api/pdf-imports/{job.pk}/pages/",
            {
                "client_id": str(key or uuid.uuid4()),
                "start_page": first,
                "end_page": last,
                "revision": revision,
            },
            format="json",
        )

    def confirm(self, job, revision=1):
        return self.client.post(
            f"/api/pdf-imports/{job.pk}/confirm/",
            {
                "client_id": str(uuid.uuid4()),
                "title": "確認した章",
                "text": "本人が修正した本文。",
                "selection_revision": revision,
            },
            format="json",
        )


class PdfPageTests(PageSetup, TestCase):
    def test_document_deleted_after_confirmation_before_response_returns_404_without_resurrection(
        self,
    ):
        job = self.known()
        self.select(job)
        pdf_imports.work_once()
        original = pdf_imports.confirm

        def delete_before_serialization(*args, **kwargs):
            document, created = original(*args, **kwargs)
            document.delete()
            return document, created

        with (
            patch(
                "capture.pdf_imports.confirm", side_effect=delete_before_serialization
            ),
            self.captureOnCommitCallbacks(execute=True),
        ):
            self.assertEqual(self.confirm(job).status_code, 404)
        self.assertEqual(Document.objects.count(), 0)
        self.assertEqual(self.confirm(job).status_code, 409)

    def test_real_upload_select_worker_confirm_and_private_provenance_survive_reload_and_source_deletion(
        self,
    ):
        job = self.upload(numbered_pdf(60))
        pdf_imports.work_once()
        status = self.client.get(f"/api/pdf-imports/{job.pk}/").data
        self.assertEqual(
            (status["state"], status["error_code"], status["page_count"]),
            ("failed", "page_selection_required", 60),
        )
        self.assertEqual(status["extracted_text"], "")
        key = uuid.uuid4()
        self.assertEqual(self.select(job, 52, 54, key=key).status_code, 202)
        self.assertEqual(self.select(job, 52, 54, key=key).status_code, 200)
        self.assertEqual(PdfPageRequest.objects.count(), 1)
        pdf_imports.work_once()
        job.refresh_from_db()
        self.assertEqual(
            (job.start_page, job.end_page, job.selection_revision), (52, 54, 1)
        )
        self.assertIn("ONLY_PAGE_052", job.extracted_text)
        self.assertIn("ONLY_PAGE_054", job.extracted_text)
        self.assertNotIn("ONLY_PAGE_051", job.extracted_text)
        self.assertEqual(self.confirm(job, revision=0).status_code, 409)
        confirmed = self.confirm(job)
        self.assertEqual(confirmed.status_code, 201, confirmed.data)
        self.assertEqual(self.confirm(job).data["id"], confirmed.data["id"])
        self.assertEqual(Document.objects.count(), 1)
        source = confirmed.data["source_pdf"]
        self.assertEqual(
            (source["start_page"], source["end_page"], source["page_count"]),
            (52, 54, 60),
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            PdfImport.objects.filter(pk=job.pk).update(start_page=53)
        with self.assertRaises(IntegrityError), transaction.atomic():
            PdfImport.objects.filter(pk=job.pk).update(confirmed_document_snapshot=None)
        self.assertEqual(self.select(job, 1, 2, revision=1).status_code, 409)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(f"/api/pdf-imports/{job.pk}/").status_code, 204
            )
        reloaded = self.client.get(f"/api/documents/{confirmed.data['id']}/").data
        self.assertEqual(reloaded["source_pdf"]["start_page"], 52)
        self.assertEqual(reloaded["source_pdf"]["end_page"], 54)
        self.assertFalse(reloaded["source_pdf"]["source_available"])

    def test_late_same_key_replay_returns_newer_state_without_rollback_or_reexecution(
        self,
    ):
        job = self.known()
        key = uuid.uuid4()
        self.assertEqual(self.select(job, 1, 1, key=key).status_code, 202)
        self.assertEqual(self.select(job, 2, 3, revision=1).status_code, 202)
        replay = self.select(job, 1, 1, key=key)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(
            (
                replay.data["selection_revision"],
                replay.data["start_page"],
                replay.data["end_page"],
            ),
            (2, 2, 3),
        )
        self.assertEqual(self.select(job, 2, 2, key=key).status_code, 409)
        self.assertEqual(self.select(job, 1, 2, revision=0).status_code, 409)
        self.assertEqual(PdfPageRequest.objects.count(), 2)

    def test_selection_authorization_csrf_bounds_and_revision_are_required(self):
        job = self.known()
        for first, last in [(0, 1), (2, 1), (1, 4), (1, 51)]:
            self.assertEqual(self.select(job, first, last).status_code, 400)
        self.assertEqual(PdfPageRequest.objects.count(), 0)
        self.client.force_authenticate(self.other)
        self.assertEqual(self.select(job).status_code, 404)
        self.assertEqual(self.confirm(job).status_code, 404)
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.owner)
        self.assertEqual(
            browser.post(
                f"/api/pdf-imports/{job.pk}/pages/",
                {
                    "client_id": str(uuid.uuid4()),
                    "start_page": 1,
                    "end_page": 1,
                    "revision": 0,
                },
                content_type="application/json",
            ).status_code,
            403,
        )
        self.client.force_authenticate(self.owner)
        self.assertEqual(
            self.client.post(
                f"/api/pdf-imports/{job.pk}/pages/",
                {"client_id": str(uuid.uuid4()), "start_page": 1, "end_page": 1},
                format="json",
            ).status_code,
            400,
        )

    def test_old_worker_cannot_publish_text_or_failure_after_a_new_page_selection(self):
        job = self.known()
        self.select(job, 1, 1)
        claimed = pdf_imports.claim_job()

        def select_during_extract(*args, **kwargs):
            self.assertEqual(self.select(job, 2, 3, revision=1).status_code, 202)
            return {
                "text": "STALE_PAGE_001",
                "page_count": 3,
                "start_page": 1,
                "end_page": 1,
            }

        with patch("capture.pdf_sandbox.extract", side_effect=select_during_extract):
            pdf_imports.process_job(claimed)
        job.refresh_from_db()
        self.assertEqual(
            (job.state, job.start_page, job.end_page, job.extracted_text),
            ("queued", 2, 3, ""),
        )
        self.assertEqual(job.selection_revision, 2)
        pdf_imports.work_once()
        job.refresh_from_db()
        self.assertNotIn("ONLY_PAGE_001", job.extracted_text)
        self.assertIn("ONLY_PAGE_003", job.extracted_text)
        self.assertEqual(self.confirm(job, revision=1).status_code, 409)

    def test_expiry_deletion_and_selection_limit_refuse_new_work(self):
        job = self.known()
        PdfImport.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertEqual(self.select(job).status_code, 409)
        PdfImport.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() + timedelta(hours=1)
        )
        with patch("capture.pdf_pages.MAX_SELECTIONS", 1):
            self.assertEqual(self.select(job).status_code, 202)
            self.assertEqual(self.select(job, 1, 1, revision=1).status_code, 409)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"/api/pdf-imports/{job.pk}/")
        self.assertEqual(self.select(job, 1, 1, revision=1).status_code, 409)

    def test_database_rejects_partial_out_of_source_or_excess_page_ranges(self):
        job = self.known()
        for change in [
            {"start_page": 1},
            {"end_page": 2},
            {"start_page": 1, "end_page": 4},
            {"page_count": 201},
            {"page_count": 100, "start_page": 1, "end_page": 51},
        ]:
            with (
                self.subTest(change=change),
                self.assertRaises(IntegrityError),
                transaction.atomic(),
            ):
                PdfImport.objects.filter(pk=job.pk).update(**change)


class ConcurrentPdfPageTests(PageSetup, TransactionTestCase):
    def test_reverse_refuses_before_dropping_selected_provenance_or_receipts(self):
        job = self.known()
        self.assertEqual(self.select(job).status_code, 202)
        database = connections["default"]
        leaves = MigrationExecutor(database).loader.graph.leaf_nodes()
        try:
            with self.assertRaisesMessage(RuntimeError, "PDF page selections exist"):
                MigrationExecutor(database).migrate(
                    [("capture", "0007_audio_playlist")]
                )
            job.refresh_from_db()
            self.assertEqual(
                (job.start_page, job.end_page, job.selection_revision), (2, 3, 1)
            )
            self.assertEqual(PdfPageRequest.objects.count(), 1)
        finally:
            # Newer, independently reversible migrations may already have run
            # before 0008's guard refuses. Every schema test restores its leaf.
            MigrationExecutor(database).migrate(leaves)

    def test_two_competing_selections_accept_only_one_revision(self):
        job = self.known()
        barrier = Barrier(2)

        def select(first):
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                try:
                    pdf_pages.select_pages(
                        self.owner,
                        job.pk,
                        {
                            "client_id": uuid.uuid4(),
                            "start_page": first,
                            "end_page": first,
                            "revision": 0,
                        },
                    )
                    return "accepted"
                except Conflict:
                    return "conflict"
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(select, [1, 2]))
        self.assertEqual(sorted(outcomes), ["accepted", "conflict"])
        job.refresh_from_db()
        self.assertEqual(job.selection_revision, 1)
        self.assertEqual(PdfPageRequest.objects.count(), 1)
