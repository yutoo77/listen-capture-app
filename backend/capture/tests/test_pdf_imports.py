from datetime import timedelta
import io
import os
from pathlib import Path
import tempfile
import time
from unittest import skipUnless
from unittest.mock import patch
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.cache import cache
from django.db import IntegrityError, close_old_connections, connections, transaction
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from rest_framework.test import APIClient

from capture import pdf_imports, pdf_sandbox, services, storage
from capture.models import Document, PdfImport, TextBlock


def pdf_bytes(
    text="Source paragraph.\nAnother sentence.",
    *,
    pages=1,
    encrypted=False,
    active=False,
    compressed=False,
    attachment=False,
):
    writer = PdfWriter()
    for index in range(pages):
        page = writer.add_blank_page(width=300, height=300)
        if text:
            font = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
            page[NameObject("/Resources")] = DictionaryObject(
                {
                    NameObject("/Font"): DictionaryObject(
                        {NameObject("/F1"): writer._add_object(font)}
                    )
                }
            )
            stream = DecodedStreamObject()
            literal = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream.set_data(f"BT /F1 12 Tf 10 50 Td ({literal}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(
                stream.flate_encode() if compressed else stream
            )
    if encrypted:
        writer.encrypt("synthetic-password")
    if active:
        writer.add_js("app.alert('synthetic')")
    if attachment:
        writer.add_attachment("synthetic.txt", b"synthetic attachment")
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue()


def japanese_pdf_bytes():
    text = "日本語の資料を確認します。"
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    characters = list(dict.fromkeys(text))
    mapping = {character: index + 1 for index, character in enumerate(characters)}
    cmap = DecodedStreamObject()
    pairs = "\n".join(
        f"<{mapping[character]:04X}> <{ord(character):04X}>" for character in characters
    )
    cmap.set_data(
        (
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /Synthetic def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
            + f"{len(characters)} beginbfchar\n{pairs}\nendbfchar\nendcmap end end"
        ).encode("ascii")
    )
    descendant = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/CIDFontType2"),
            NameObject("/BaseFont"): NameObject("/SyntheticJapanese"),
            NameObject("/CIDSystemInfo"): DictionaryObject(
                {
                    NameObject("/Registry"): TextStringObject("Adobe"),
                    NameObject("/Ordering"): TextStringObject("Identity"),
                    NameObject("/Supplement"): NumberObject(0),
                }
            ),
            NameObject("/DW"): NumberObject(1000),
        }
    )
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type0"),
            NameObject("/BaseFont"): NameObject("/SyntheticJapanese"),
            NameObject("/Encoding"): NameObject("/Identity-H"),
            NameObject("/DescendantFonts"): ArrayObject(
                [writer._add_object(descendant)]
            ),
            NameObject("/ToUnicode"): writer._add_object(cmap),
        }
    )
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {NameObject("/F1"): writer._add_object(font)}
            )
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(
        (
            "BT /F1 12 Tf 10 50 Td <"
            + "".join(f"{mapping[character]:04X}" for character in text)
            + "> Tj ET"
        ).encode("ascii")
    )
    page[NameObject("/Contents")] = writer._add_object(stream)
    target = io.BytesIO()
    writer.write(target)
    return target.getvalue(), text


class PdfSandboxTests(TestCase):
    def test_real_isolated_parser_extracts_a_draft_and_refuses_non_text_encryption_active_content(
        self,
    ):
        result = pdf_sandbox.extract(pdf_bytes())
        self.assertIn("Source paragraph", result["text"])
        self.assertEqual(result["page_count"], 1)
        japanese, expected = japanese_pdf_bytes()
        self.assertEqual(pdf_sandbox.extract(japanese)["text"], expected)
        for data, code in [
            (pdf_bytes(text=""), "no_text"),
            (pdf_bytes(encrypted=True), "encrypted_pdf"),
            (pdf_bytes(active=True), "active_content"),
            (pdf_bytes(attachment=True), "active_content"),
            (pdf_bytes(text="", pages=201), "page_limit"),
            (b"%PDF-1.7\nbroken", "invalid_pdf"),
        ]:
            with (
                self.subTest(code=code),
                self.assertRaises(pdf_sandbox.PdfFailure) as error,
            ):
                pdf_sandbox.extract(data)
            self.assertEqual(error.exception.code, code)

    def test_actual_compressed_content_and_extracted_text_are_bounded(self):
        with self.assertRaises(pdf_sandbox.PdfFailure) as error:
            pdf_sandbox.extract(pdf_bytes("x" * 20001, compressed=True))
        self.assertEqual(error.exception.code, "text_limit")
        with self.assertRaises(pdf_sandbox.PdfFailure) as error:
            pdf_sandbox.extract(pdf_bytes(" " * (5 * 1024 * 1024), compressed=True))
        self.assertEqual(error.exception.code, "resource_limit")

    def test_wall_deadline_kills_isolated_process_without_unbounded_output(self):
        # Force an actual child deadline, rather than replacing the PDF parser.
        with patch("capture.pdf_sandbox.MAX_SECONDS", 0.001):
            with self.assertRaises(pdf_sandbox.PdfFailure) as error:
                pdf_sandbox.extract(pdf_bytes())
        self.assertEqual(error.exception.code, "processing_timeout")

    @skipUnless(os.name == "nt", "Windows JobObject memory enforcement")
    def test_os_memory_limit_stops_real_child_allocation(self):
        data = pdf_bytes()
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "allocate.py"
            script.write_text(
                "import sys\nsys.stdin.buffer.read(1)\nallocation = bytearray(2 * 1024 * 1024 * 1024)\n"
            )
            with patch("capture.pdf_sandbox.Path.with_name", return_value=script):
                with self.assertRaises(pdf_sandbox.PdfFailure) as error:
                    pdf_sandbox.extract(data)
            self.assertEqual(error.exception.code, "resource_limit")


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class PdfImportTests(TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        setting = override_settings(PRIVATE_MEDIA_ROOT=Path(temporary.name))
        setting.enable()
        self.addCleanup(setting.disable)
        self.owner = get_user_model().objects.create_user("pdf-owner")
        self.other = get_user_model().objects.create_user("pdf-other")
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_normal_read_traffic_does_not_exhaust_pdf_upload_throttle(self):
        read_key = f"throttle_user_{self.owner.pk}"
        upload_key = f"throttle_pdf_upload_{self.owner.pk}"
        cache.delete(upload_key)
        self.addCleanup(cache.delete, read_key)
        self.addCleanup(cache.delete, upload_key)
        cache.set(read_key, [time.time()] * 30, 3600)
        self.assertEqual(self.upload().status_code, 202)
        cache.set(upload_key, [time.time()] * 30, 3600)
        self.assertEqual(self.upload().status_code, 429)

    def upload(self, data=None, client_id=None):
        return self.client.post(
            "/api/pdf-imports/",
            {
                "client_id": str(client_id or uuid.uuid4()),
                "file": SimpleUploadedFile(
                    "synthetic.pdf",
                    data if data is not None else pdf_bytes(),
                    content_type="application/pdf",
                ),
            },
            format="multipart",
        )

    def ready(self):
        response = self.upload()
        self.assertEqual(response.status_code, 202)
        job = PdfImport.objects.get(pk=response.data["id"])
        claimed = pdf_imports.claim_job()
        self.assertEqual(claimed.pk, job.pk)
        pdf_imports.process_job(claimed)
        job.refresh_from_db()
        self.assertEqual(job.state, "succeeded")
        return job

    def confirm(self, job, **changes):
        values = {
            "client_id": str(uuid.uuid4()),
            "title": "確認した日本語資料",
            "text": "修正済みの本文です。\n\n😀 次の段落です。",
        } | changes
        return self.client.post(
            f"/api/pdf-imports/{job.pk}/confirm/", values, format="json"
        )

    def test_upload_worker_edit_confirm_receipt_original_and_exact_immutable_blocks(
        self,
    ):
        job = self.ready()
        response = self.confirm(job)
        self.assertEqual(response.status_code, 201)
        document = Document.objects.get(pk=response.data["id"])
        version = document.versions.first()
        self.assertEqual(version.text, "修正済みの本文です。\n\n😀 次の段落です。")
        blocks = list(version.text_blocks.all())
        self.assertEqual("".join(block.text for block in blocks), version.text)
        self.assertEqual(
            [block.id for block in services.ensure_text_blocks(version)],
            [block.id for block in blocks],
        )
        context = self.client.get(
            f"/api/documents/{document.pk}/versions/{version.pk}/"
        )
        self.assertEqual(context.data["blocks"][0]["text"], version.text)
        replay = self.confirm(job)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.data["id"], response.data["id"])
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(self.confirm(job, text="異なる本文").status_code, 409)
        source = self.client.get(f"/api/pdf-imports/{job.pk}/source/")
        self.assertEqual(source.status_code, 200)
        self.assertTrue(source["Content-Disposition"].startswith("attachment"))
        self.assertEqual(int(source["Content-Length"]), job.source_size_bytes)
        self.assertEqual(b"".join(source.streaming_content), pdf_bytes())
        source.close()

    def test_upload_replay_mismatch_forged_fields_and_size_magic(self):
        key = uuid.uuid4()
        first = self.upload(client_id=key)
        self.assertEqual(self.upload(client_id=key).data["id"], first.data["id"])
        self.assertEqual(
            self.upload(pdf_bytes("Different"), client_id=key).status_code, 409
        )
        self.assertEqual(PdfImport.objects.count(), 1)
        for data in (b"not pdf", b"%PDF-" + b"x" * pdf_sandbox.MAX_BYTES):
            self.assertEqual(self.upload(data).status_code, 400)
        response = self.client.post(
            "/api/pdf-imports/",
            {
                "client_id": str(uuid.uuid4()),
                "owner": str(self.other.pk),
                "file": SimpleUploadedFile("x.pdf", pdf_bytes()),
            },
            format="multipart",
        )
        self.assertEqual(response.status_code, 400)

    def test_original_storage_outage_is_retryable_and_ownership_precedes_remote_access(
        self,
    ):
        job = self.ready()
        with patch(
            "capture.pdf_views.storage.stat", side_effect=storage.StorageUnavailable()
        ):
            response = self.client.get(f"/api/pdf-imports/{job.pk}/source/")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response["Retry-After"], "30")
        with patch(
            "capture.pdf_views.storage.open_read", side_effect=storage.StorageMissing()
        ):
            self.assertEqual(
                self.client.get(f"/api/pdf-imports/{job.pk}/source/").status_code, 404
            )
        self.client.force_authenticate(self.other)
        with patch("capture.pdf_views.storage.stat") as stat:
            self.assertEqual(
                self.client.get(f"/api/pdf-imports/{job.pk}/source/").status_code, 404
            )
            stat.assert_not_called()

    def test_foreign_and_anonymous_access_never_disclose_draft_or_source(self):
        job = self.ready()
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get("/api/pdf-imports/").data, [])
        for suffix in ("", "source/"):
            self.assertEqual(
                self.client.get(f"/api/pdf-imports/{job.pk}/{suffix}").status_code, 404
            )
        self.assertEqual(self.confirm(job).status_code, 404)
        self.assertEqual(
            self.client.delete(f"/api/pdf-imports/{job.pk}/").status_code, 404
        )
        self.assertEqual(
            APIClient().get(f"/api/pdf-imports/{job.pk}/source/").status_code, 403
        )

    def test_session_upload_and_confirmation_require_csrf(self):
        browser = Client(enforce_csrf_checks=True)
        browser.force_login(self.owner)
        self.assertEqual(
            browser.post(
                "/api/pdf-imports/",
                {
                    "client_id": str(uuid.uuid4()),
                    "file": SimpleUploadedFile("x.pdf", pdf_bytes()),
                },
            ).status_code,
            403,
        )

        job = self.ready()
        self.assertEqual(
            browser.post(
                f"/api/pdf-imports/{job.pk}/confirm/",
                {"title": "a", "text": "b", "client_id": str(uuid.uuid4())},
                content_type="application/json",
            ).status_code,
            403,
        )

    def test_stale_workspace_header_refuses_upload_into_another_authenticated_account(
        self,
    ):
        self.client.force_authenticate(self.other)
        with patch("capture.pdf_imports.enqueue") as enqueue:
            response = self.client.post(
                "/api/pdf-imports/",
                {
                    "client_id": str(uuid.uuid4()),
                    "file": SimpleUploadedFile("synthetic.pdf", pdf_bytes()),
                },
                format="multipart",
                HTTP_X_WORKSPACE_USER=str(self.owner.pk),
            )
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.data["code"], "workspace_changed")
            enqueue.assert_not_called()
        self.assertEqual(PdfImport.objects.count(), 0)
        self.assertEqual(list(storage.files()), [])
        response = self.client.post(
            "/api/pdf-imports/",
            {
                "client_id": str(uuid.uuid4()),
                "file": SimpleUploadedFile("synthetic.pdf", pdf_bytes()),
            },
            format="multipart",
            HTTP_X_WORKSPACE_USER=str(self.other.pk),
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            PdfImport.objects.get(pk=response.data["id"]).owner_id, self.other.pk
        )

    def test_source_delete_and_document_delete_remove_after_commit_without_resurrection(
        self,
    ):
        job = self.ready()
        doc_id = self.confirm(job).data["id"]
        key = job.storage_key
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(
                self.client.delete(f"/api/pdf-imports/{job.pk}/").status_code, 204
            )
        self.assertTrue(Document.objects.filter(pk=doc_id).exists())
        self.assertFalse(storage.path_for(key).exists())
        self.assertEqual(self.confirm(job).status_code, 200)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"/api/documents/{doc_id}/")
        self.assertEqual(self.confirm(job).status_code, 409)

    def test_document_cascade_purges_original_and_stale_worker_cannot_publish(self):
        job = self.ready()
        doc_id = self.confirm(job).data["id"]
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"/api/documents/{doc_id}/")
        job.refresh_from_db()
        self.assertIsNone(job.storage_key)
        self.assertEqual(job.error_code, "parent_deleted")
        pending = PdfImport.objects.get(pk=self.upload().data["id"])
        claimed = pdf_imports.claim_job()
        with self.captureOnCommitCallbacks(execute=True):
            pdf_imports.remove(self.owner, pending.pk)
        with patch("capture.pdf_sandbox.extract") as extract:
            pdf_imports.process_job(claimed)
            extract.assert_not_called()
        self.assertEqual(Document.objects.count(), 0)

    def test_expiry_and_lease_timeout_purge_drafts_and_fence_late_results(self):
        job = self.ready()
        PdfImport.objects.filter(pk=job.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(pdf_imports.expire_jobs(), 1)
        job.refresh_from_db()
        self.assertIsNone(job.storage_key)
        self.assertEqual(job.extracted_text, "")
        self.assertEqual(self.confirm(job).status_code, 409)
        self.upload()
        claimed = pdf_imports.claim_job()
        PdfImport.objects.filter(pk=claimed.pk).update(
            lease_expires_at=timezone.now() - timedelta(seconds=1)
        )
        pdf_imports.expire_jobs()
        pdf_imports.process_job(claimed)
        claimed.refresh_from_db()
        self.assertEqual(claimed.state, "failed")
        self.assertEqual(claimed.error_code, "processing_timeout")

    def test_storage_and_transaction_failures_leave_no_receipt_or_orphan(self):
        with patch("capture.pdf_imports.storage.put_bytes", side_effect=OSError()):
            with self.assertRaises(OSError):
                pdf_imports.enqueue(
                    self.owner, SimpleUploadedFile("x.pdf", pdf_bytes()), uuid.uuid4()
                )
        self.assertEqual(PdfImport.objects.count(), 0)
        with patch(
            "capture.pdf_imports.PdfImport.objects.create", side_effect=IntegrityError()
        ):
            with self.assertRaises(IntegrityError):
                pdf_imports.enqueue(
                    self.owner, SimpleUploadedFile("x.pdf", pdf_bytes()), uuid.uuid4()
                )
        self.assertEqual(list(storage.files()), [])

    def test_retained_source_count_bytes_and_shared_storage_quota_bound_upload(self):
        self.upload()
        with patch("capture.pdf_imports.MAX_IMPORTS", 1):
            self.assertEqual(self.upload().status_code, 409)
        with patch("capture.pdf_imports.MAX_SOURCE_BYTES", 1):
            self.assertEqual(self.upload().status_code, 409)
        with override_settings(MAX_PRIVATE_BYTES_PER_USER=1):
            self.assertEqual(self.upload().status_code, 409)

    def test_many_tiny_paragraphs_preserve_unicode_offsets_with_bounded_rows(self):
        text = "😀\n" * 10000
        document = services.create_document(self.owner, {"title": "段落", "text": text})
        version = document.versions.first()
        blocks = list(version.text_blocks.all())
        self.assertLessEqual(len(blocks), 40)
        self.assertEqual("".join(block.text for block in blocks), text)
        for block in blocks:
            self.assertEqual(block.text, text[block.start_offset : block.end_offset])
        with self.assertRaises(ValueError):
            blocks[0].save()
        with self.assertRaises(IntegrityError), transaction.atomic():
            TextBlock.objects.create(
                version=version, index=0, start_offset=0, end_offset=0, text=""
            )


@override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])
class ConcurrentPdfTests(TransactionTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        setting = override_settings(PRIVATE_MEDIA_ROOT=Path(temporary.name))
        setting.enable()
        self.addCleanup(setting.disable)
        self.owner = get_user_model().objects.create_user("concurrent-pdf")

    def concurrent(self, action):
        barrier = Barrier(2)

        def execute():
            close_old_connections()
            try:
                barrier.wait(timeout=10)
                return action()
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(lambda _: execute(), range(2)))

    def test_simultaneous_upload_and_confirm_create_one_source_and_one_document(self):
        data, client_id = pdf_bytes(), uuid.uuid4()
        uploads = self.concurrent(
            lambda: pdf_imports.enqueue(
                self.owner, SimpleUploadedFile("x.pdf", data), client_id
            )
        )
        self.assertEqual(PdfImport.objects.count(), 1)
        self.assertEqual(len(list(storage.files())), 1)
        self.assertEqual(uploads[0][0].id, uploads[1][0].id)
        claimed = pdf_imports.claim_job()
        pdf_imports.process_job(claimed)
        values = {"title": "確定", "text": "同じ本文です。", "client_id": uuid.uuid4()}
        documents = self.concurrent(
            lambda: pdf_imports.confirm(self.owner, claimed.id, values)
        )
        self.assertEqual(Document.objects.count(), 1)
        self.assertEqual(documents[0][0].id, documents[1][0].id)
        self.assertEqual(sorted(created for _, created in documents), [False, True])
