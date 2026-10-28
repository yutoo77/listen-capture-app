"""Restore a synthetic DB+private-audio pair into a new disposable PostgreSQL DB.

Never reads/writes the application's active database or private media. Uses the
configured PostgreSQL role only to create/drop unique lc_restore_* databases.
Artifacts stay under ignored .local/recovery-drill-*; credentials are not logged.
"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import uuid
import wave
from unittest.mock import patch

from backup_private import (
    ROOT,
    backup_pair,
    create_disposable_database,
    drop_disposable_database,
    restore_pair,
    sha256,
    verify_pair,
)
from manage import load_env


# This is seeded synthetic provenance, not a claim that an engine generated it.
VOICEVOX_PROFILE = {
    "provider": "voicevox",
    "engine_version": "0.25.2",
    "core_version": "0.15.0",
    "speaker_id": 14,
    "speaker_uuid": "synthetic-recovery-character",
    "speaker_version": "1.0",
    "name": "合成復元試験",
    "style": "ノーマル",
    "credit": "VOICEVOX:合成復元試験",
    "pitch_scale": 0.08,
    "sample_rate": 16000,
    "channels": 1,
}
VOICEVOX_VOICE = {"speaker_id": 14, "pitch_scale": 0.08}


def stage(database, media_root, action):
    """Separate process avoids switching a live Django ORM connection between DBs."""
    if not database.startswith("lc_restore_"):
        raise ValueError("Drill stages require a disposable database")
    os.environ.update(
        POSTGRES_DB=database,
        PRIVATE_MEDIA_ROOT=str(media_root),
        PRIVATE_STORAGE_BACKEND="local",
        PRIVATE_S3_USE_APPROVED="0",
        DJANGO_DEBUG="1",
        DJANGO_ALLOWED_HOSTS="testserver,localhost,127.0.0.1",
        POLLY_ENABLED="0",
        POLLY_BILLING_APPROVED="0",
        LC_E2E_FIXTURE_TTS="0",
        LC_TEST_ENVIRONMENT="0",
        VOICEVOX_ENABLED="0",
    )
    os.environ.pop("DATABASE_URL", None)
    sys.path.insert(0, str(ROOT / "backend"))
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
    import django

    django.setup()
    from django.contrib.auth import get_user_model
    from django.core.management import call_command
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.db import IntegrityError, connection, transaction
    from django.test import Client, override_settings
    from capture import pdf_imports, pdf_pages, progress, services, storage
    from capture.voicevox_provider import profile_hash
    from capture.models import (
        AudioSegment,
        AudioVersion,
        Document,
        DocumentVersion,
        MemoSubmission,
        PdfImport,
        PdfPageRequest,
        VoiceMemo,
    )
    from capture.narration_models import (
        NarrationJob,
        NarrationRequest,
        NarrationSegment,
    )
    from capture.narration_encoding import encode

    assert connection.settings_dict["NAME"] == database
    if action == "seed":
        call_command("migrate", interactive=False, verbosity=0)
        media_root.mkdir(parents=True, exist_ok=False)
        user_model = get_user_model()
        alice = user_model.objects.create_user(
            username="synthetic_alice", password=secrets.token_urlsafe(24)
        )
        user_model.objects.create_user(
            username="synthetic_bob", password=secrets.token_urlsafe(24)
        )
        document = services.create_document(
            alice,
            {
                "title": "Synthetic recovery fixture",
                "text": "復元確認用の架空の資料です。個人の録音は使っていません。",
            },
        )
        audio_bytes = (ROOT / "backend/demo/sample.mp3").read_bytes()
        audio = AudioVersion.objects.create(
            document_version=document.versions.first(),
            kind="demo",
            storage_key=storage.put_bytes(audio_bytes, "mp3"),
            content_type="audio/mpeg",
            duration_ms=187000,
            size_bytes=len(audio_bytes),
        )
        pcm = io.BytesIO()
        with wave.open(pcm, "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"\x00\x00" * 8000)
        memo, created = services.create_memo(
            alice,
            {
                "client_id": uuid.uuid4(),
                "audio_version": audio.id,
                "position_ms": 1234,
                "duration_ms": 500,
                "text": "Synthetic memo",
                "audio": SimpleUploadedFile(
                    "fixture.wav", pcm.getvalue(), content_type="audio/wav"
                ),
            },
        )
        assert created and memo.position_ms == 1234
        progress.update(
            alice,
            audio.id,
            {"position_ms": 12345, "revision": 0, "client_id": uuid.uuid4()},
        )
        from pypdf import PdfWriter

        pdf_data = io.BytesIO()
        writer = PdfWriter()
        for _ in range(3):
            writer.add_blank_page(width=300, height=300)
        writer.write(pdf_data)
        pdf_bytes = pdf_data.getvalue()
        PdfImport.objects.create(
            owner=alice,
            client_id=uuid.uuid4(),
            payload_digest=hashlib.sha256(pdf_bytes).hexdigest(),
            suggested_title="Synthetic pending PDF",
            storage_key=storage.put_bytes(pdf_bytes, "pdf"),
            source_size_bytes=len(pdf_bytes),
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        # A second, synthetic source carries 0008 selection/confirmation receipts.
        # This recovery fixture does not exercise PDF extraction: the extraction
        # result is seeded, then the real selection/confirmation services run.
        selected_pdf = PdfImport.objects.create(
            owner=alice,
            client_id=uuid.uuid4(),
            payload_digest=hashlib.sha256(pdf_bytes).hexdigest(),
            suggested_title="Synthetic selected PDF",
            storage_key=storage.put_bytes(pdf_bytes, "pdf"),
            source_size_bytes=len(pdf_bytes),
            page_count=3,
            state="failed",
            error_code="page_selection_required",
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        selected_pdf, changed = pdf_pages.select_pages(
            alice,
            selected_pdf.pk,
            {"client_id": uuid.uuid4(), "start_page": 2, "end_page": 3, "revision": 0},
        )
        assert changed and selected_pdf.selection_revision == 1
        old_text = (
            "復元確認用の選択ページの本文です。後から改訂してもこの文脈を保ちます。"
        )
        selected_pdf.state, selected_pdf.extracted_text = "succeeded", old_text
        selected_pdf.save()
        pdf_document, created = pdf_imports.confirm(
            alice,
            selected_pdf.pk,
            {
                "client_id": uuid.uuid4(),
                "title": "Synthetic confirmed PDF",
                "text": old_text,
                "selection_revision": 1,
            },
        )
        assert created
        version = document.versions.first()
        narration = NarrationJob.objects.create(
            owner=alice,
            document_version=version,
            document_id_snapshot=document.id,
            version_id_snapshot=version.id,
            reading_text=version.text,
            character_count=len(version.text),
            provider="fixture",
            state="failed",
        )
        partial = b"\0\0" * 1600
        NarrationSegment.objects.create(
            job=narration,
            index=0,
            start_offset=0,
            end_offset=len(version.text),
            state="succeeded",
            storage_key=storage.put_bytes(partial, "pcm"),
            size_bytes=len(partial),
            digest=hashlib.sha256(partial).hexdigest(),
            frames=1600,
            duration_ms=100,
            attempt_count=1,
        )
        published_data = io.BytesIO()
        with wave.open(published_data, "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"\0\0" * 1600)
        published = published_data.getvalue()
        pdf_version = pdf_document.versions.first()
        with transaction.atomic():
            playlist = AudioVersion.objects.create(
                document_version=pdf_version,
                kind="fixture",
                delivery="playlist",
                storage_key=None,
                content_type="audio/wav",
                size_bytes=len(published),
                duration_ms=100,
            )
            AudioSegment.objects.create(
                audio_version=playlist,
                index=0,
                storage_key=storage.put_bytes(published, "wav"),
                size_bytes=len(published),
                frames=1600,
                start_ms=0,
                end_ms=100,
                duration_ms=100,
                start_offset=0,
                end_offset=len(pdf_version.text),
            )
        progress.update(
            alice,
            playlist.id,
            {"position_ms": 50, "revision": 0, "client_id": uuid.uuid4()},
        )
        playlist_memo, created = services.create_memo(
            alice,
            {
                "client_id": uuid.uuid4(),
                "audio_version": playlist.pk,
                "position_ms": 50,
                "duration_ms": 500,
                "text": "Synthetic old PDF context",
                "audio": SimpleUploadedFile(
                    "fixture.wav", pcm.getvalue(), content_type="audio/wav"
                ),
            },
        )
        assert (
            created
            and playlist_memo.audio_version.document_version_id == pdf_version.pk
        )
        # Preserve the old WAV publication above. This additional synthetic
        # 1-second PCM publication exercises the actual current MP3 encoder,
        # paired backup and restored owner-scoped media, not provider speech.
        compressed_pcm = b"\0\0" * 16000
        with override_settings(NARRATION_ENCODING="mp3"):
            compressed = encode(compressed_pcm)
        assert compressed.content_type == "audio/mpeg" and compressed.suffix == "mp3"
        with transaction.atomic():
            compressed_playlist = AudioVersion.objects.create(
                document_version=pdf_version,
                kind="fixture",
                delivery="playlist",
                storage_key=None,
                content_type=compressed.content_type,
                size_bytes=len(compressed.data),
                duration_ms=1000,
            )
            AudioSegment.objects.create(
                audio_version=compressed_playlist,
                index=0,
                storage_key=storage.put_bytes(compressed.data, compressed.suffix),
                content_type=compressed.content_type,
                size_bytes=len(compressed.data),
                frames=16000,
                start_ms=0,
                end_ms=1000,
                duration_ms=1000,
                start_offset=0,
                end_offset=len(pdf_version.text),
            )
        progress.update(
            alice,
            compressed_playlist.id,
            {"position_ms": 500, "revision": 0, "client_id": uuid.uuid4()},
        )
        compressed_memo, created = services.create_memo(
            alice,
            {
                "client_id": uuid.uuid4(),
                "audio_version": compressed_playlist.pk,
                "position_ms": 500,
                "duration_ms": 500,
                "text": "Synthetic compressed old PDF context",
                "audio": SimpleUploadedFile(
                    "fixture.wav", pcm.getvalue(), content_type="audio/wav"
                ),
            },
        )
        assert created and compressed_memo.audio_version_id == compressed_playlist.pk
        # Exercise 0010 provenance in the dump itself, while leaving both existing
        # WAV/MP3 playlist fixtures and the retained partial unchanged. No engine
        # endpoint, catalog or paid provider is used to construct this fixture.
        voicevox_audio = AudioVersion.objects.create(
            document_version=version,
            kind="voicevox",
            synthesis_profile=VOICEVOX_PROFILE,
            storage_key=storage.put_bytes(published, "wav"),
            content_type="audio/wav",
            size_bytes=len(published),
            duration_ms=100,
        )
        voicevox_job = NarrationJob.objects.create(
            owner=alice,
            document_version=version,
            document_id_snapshot=document.pk,
            version_id_snapshot=version.pk,
            reading_text=version.text,
            provider="voicevox",
            voice_settings=VOICEVOX_VOICE,
            synthesis_profile=VOICEVOX_PROFILE,
            profile_hash=profile_hash(VOICEVOX_PROFILE),
            character_count=len(version.text),
            state="succeeded",
            audio_version=voicevox_audio,
        )
        NarrationSegment.objects.create(
            job=voicevox_job,
            index=0,
            start_offset=0,
            end_offset=len(version.text),
            state="succeeded",
            digest=hashlib.sha256(partial).hexdigest(),
            frames=1600,
            duration_ms=100,
            start_ms=0,
            end_ms=100,
            attempt_count=1,
        )
        NarrationRequest.objects.create(
            owner=alice,
            client_id=uuid.uuid4(),
            job=voicevox_job,
            operation="start",
        )
        voicevox_memo, created = services.create_memo(
            alice,
            {
                "client_id": uuid.uuid4(),
                "audio_version": voicevox_audio.pk,
                "position_ms": 50,
                "duration_ms": 500,
                "text": "Synthetic VOICEVOX old context",
                "audio": SimpleUploadedFile(
                    "fixture.wav", pcm.getvalue(), content_type="audio/wav"
                ),
            },
        )
        assert created and voicevox_memo.audio_version_id == voicevox_audio.pk
        progress.update(
            alice,
            voicevox_audio.pk,
            {"position_ms": 60, "revision": 0, "client_id": uuid.uuid4()},
        )
        services.update_document(
            alice,
            document.pk,
            {"text": "VOICEVOX復元試験の改訂後本文。旧録音は旧版を参照します。"},
        )
        services.update_document(
            alice,
            pdf_document.pk,
            {"text": "改訂後の本文です。録音は旧本文に紐付いたままです。"},
        )
        return {
            "seeded_users": 2,
            "documents": 2,
            "audio_versions": 4,
            "memos": 4,
            "progress_position_ms": 12345,
            "pending_pdf_sources": 1,
            "retained_narration_partials": 1,
            "published_playlist_segments": 2,
            "published_mp3_segments": 1,
            "pdf_selection_receipts": 1,
            "confirmed_pdf_sources": 1,
            "old_context_playlist_memos": 2,
            "synthetic_voicevox_profiles": 1,
            "voicevox_narration_receipts": 1,
            "voicevox_old_context_memos": 1,
        }

    assert get_user_model().objects.count() == 2
    assert Document.objects.count() == 2 and DocumentVersion.objects.count() == 4
    assert VoiceMemo.objects.count() == MemoSubmission.objects.count() == 4
    assert AudioVersion.objects.count() == 4 and AudioSegment.objects.count() == 2
    alice = get_user_model().objects.get(username="synthetic_alice")
    bob = get_user_model().objects.get(username="synthetic_bob")
    document, memo, audio = (
        Document.objects.get(title="Synthetic recovery fixture"),
        VoiceMemo.objects.get(audio_version__kind="demo"),
        AudioVersion.objects.get(kind="demo"),
    )
    playlist = AudioVersion.objects.get(delivery="playlist", content_type="audio/wav")
    published = AudioSegment.objects.get(audio_version=playlist)
    compressed_playlist = AudioVersion.objects.get(
        delivery="playlist", content_type="audio/mpeg"
    )
    compressed_segment = AudioSegment.objects.get(audio_version=compressed_playlist)
    compressed_memo = VoiceMemo.objects.get(audio_version=compressed_playlist)
    compressed_urls = (
        f"/api/audio/{compressed_playlist.pk}/playlist/",
        f"/api/audio/{compressed_playlist.pk}/segments/0/content/",
        f"/api/audio/{compressed_playlist.pk}/progress/",
        f"/api/memos/{compressed_memo.pk}/",
        f"/api/memos/{compressed_memo.pk}/content/",
    )
    playlist_url = f"/api/audio/{playlist.pk}/playlist/"
    published_url = f"/api/audio/{playlist.pk}/segments/0/content/"
    playlist_progress_url = f"/api/audio/{playlist.pk}/progress/"
    pdf_import = PdfImport.objects.get(confirmed_document_snapshot__isnull=True)
    assert pdf_import.state == "queued" and pdf_import.storage_key
    narration = NarrationJob.objects.get(provider="fixture")
    segment = NarrationSegment.objects.get(job=narration)
    voicevox_job = NarrationJob.objects.get(provider="voicevox")
    voicevox_audio = AudioVersion.objects.get(kind="voicevox")
    voicevox_memo = VoiceMemo.objects.get(audio_version=voicevox_audio)
    voicevox_receipt = NarrationRequest.objects.get(job=voicevox_job)
    voicevox_urls = (
        f"/api/audio/{voicevox_audio.pk}/content/",
        f"/api/audio/{voicevox_audio.pk}/progress/",
        f"/api/audio/{voicevox_audio.pk}/narration-map/",
        f"/api/memos/{voicevox_memo.pk}/",
        f"/api/memos/{voicevox_memo.pk}/content/",
        f"/api/narrations/{voicevox_job.pk}/",
    )
    assert narration.state == "failed" and segment.state == "succeeded"
    assert storage.read_bytes(segment.storage_key, max_bytes=3200) == b"\0\0" * 1600
    assert memo.position_ms == 1234 and memo.duration_ms == 500
    assert (
        memo.audio_version.document_version.document.owner_id
        == memo.submission.owner_id
        == alice.pk
    )
    client = Client()
    assert client.get(f"/api/memos/{memo.pk}/content/").status_code == 403
    assert client.get(f"/api/pdf-imports/{pdf_import.pk}/source/").status_code == 403
    assert client.get(f"/api/narrations/{narration.pk}/").status_code == 403
    for endpoint in (
        playlist_url,
        published_url,
        playlist_progress_url,
        *compressed_urls,
        *voicevox_urls,
    ):
        assert client.get(endpoint).status_code == 403
    client.force_login(bob)
    for endpoint in (
        f"/api/documents/{document.pk}/",
        f"/api/memos/{memo.pk}/",
        f"/api/memos/{memo.pk}/content/",
        f"/api/audio/{audio.pk}/content/",
        f"/api/audio/{audio.pk}/progress/",
        f"/api/pdf-imports/{pdf_import.pk}/source/",
        f"/api/narrations/{narration.pk}/",
        playlist_url,
        published_url,
        playlist_progress_url,
        *compressed_urls,
        *voicevox_urls,
    ):
        assert client.get(endpoint).status_code == 404
    assert client.get("/api/memos/").json() == []
    voicevox_request = {
        "client_id": str(voicevox_receipt.client_id),
        "document_version": str(voicevox_job.version_id_snapshot),
        "provider": "voicevox",
        "voice": VOICEVOX_VOICE,
    }
    voicevox_start_url = f"/api/documents/{document.pk}/narration/"
    assert (
        client.post(
            voicevox_start_url,
            data=json.dumps(voicevox_request),
            content_type="application/json",
        ).status_code
        == 404
    )
    client.force_login(alice)
    selected_pdf = PdfImport.objects.get(confirmed_document_snapshot__isnull=False)
    receipt = PdfPageRequest.objects.get()
    pdf_document = Document.objects.get(pk=selected_pdf.confirmed_document_snapshot)
    old_version = pdf_document.versions.get(number=1)
    assert playlist.document_version_id == old_version.pk
    assert compressed_playlist.document_version_id == old_version.pk
    assert pdf_document.versions.first().number == 2
    assert (
        selected_pdf.start_page,
        selected_pdf.end_page,
        selected_pdf.selection_revision,
    ) == (2, 3, 1)
    assert (
        receipt.owner_id,
        receipt.job_id,
        receipt.base_revision,
        receipt.selected_revision,
    ) == (alice.pk, selected_pdf.pk, 0, 1)
    # Replay the original UUIDs after restore. Replaying confirmed provenance
    # must not enqueue another extraction or resurrect the earlier text version.
    replay = client.post(
        f"/api/pdf-imports/{selected_pdf.pk}/pages/",
        data=json.dumps(
            {
                "client_id": str(receipt.client_id),
                "start_page": 2,
                "end_page": 3,
                "revision": 0,
            }
        ),
        content_type="application/json",
    )
    assert replay.status_code == 200 and replay.json()["state"] == "succeeded"
    confirmation = client.post(
        f"/api/pdf-imports/{selected_pdf.pk}/confirm/",
        data=json.dumps(
            {
                "client_id": str(selected_pdf.confirm_client_id),
                "title": "Synthetic confirmed PDF",
                "text": old_version.text,
                "selection_revision": 1,
            }
        ),
        content_type="application/json",
    )
    assert confirmation.status_code == 200 and confirmation.json()["id"] == str(
        pdf_document.pk
    )
    assert confirmation.json()["current_version"]["number"] == 2
    assert Document.objects.count() == 2 and PdfPageRequest.objects.count() == 1
    mismatch = client.post(
        f"/api/pdf-imports/{selected_pdf.pk}/pages/",
        data=json.dumps(
            {
                "client_id": str(receipt.client_id),
                "start_page": 1,
                "end_page": 2,
                "revision": 0,
            }
        ),
        content_type="application/json",
    )
    assert mismatch.status_code == 409
    playlist_memo = VoiceMemo.objects.get(audio_version=playlist)
    memo_context = client.get(f"/api/memos/{playlist_memo.pk}/").json()
    assert memo_context["document_version"]["id"] == str(old_version.pk)
    assert memo_context["position_ms"] == 50
    context_url = f"/api/documents/{pdf_document.pk}/versions/{old_version.pk}/"
    context = client.get(context_url)
    assert context.status_code == 200 and context.json()["text"] == old_version.text
    assert (
        storage.stat(selected_pdf.storage_key).size_bytes
        == selected_pdf.source_size_bytes
    )
    pcm = io.BytesIO()
    with wave.open(pcm, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(16000)
        sound.writeframes(b"\x00\x00" * 8000)
    file_count = sum(path.is_file() for path in media_root.rglob("*"))
    memo_replay = client.post(
        "/api/memos/",
        {
            "client_id": str(playlist_memo.submission.client_id),
            "audio_version": str(playlist.pk),
            "position_ms": 50,
            "duration_ms": 500,
            "text": "Synthetic old PDF context",
            "audio": SimpleUploadedFile(
                "fixture.wav", pcm.getvalue(), content_type="audio/wav"
            ),
        },
    )
    assert memo_replay.status_code == 200 and memo_replay.json()["id"] == str(
        playlist_memo.pk
    )
    assert VoiceMemo.objects.count() == MemoSubmission.objects.count() == 4
    assert sum(path.is_file() for path in media_root.rglob("*")) == file_count
    client.force_login(bob)
    for endpoint in (
        f"/api/pdf-imports/{selected_pdf.pk}/",
        f"/api/pdf-imports/{selected_pdf.pk}/source/",
        f"/api/memos/{playlist_memo.pk}/",
        context_url,
    ):
        assert client.get(endpoint).status_code == 404
    client.force_login(alice)
    manifest = client.get(playlist_url).json()
    assert manifest["duration_ms"] == 100 and len(manifest["segments"]) == 1
    assert client.get(playlist_progress_url).json()["position_ms"] == 50
    published_response = client.get(published_url, HTTP_RANGE="bytes=0-43")
    assert published_response.status_code == 206
    assert b"".join(published_response.streaming_content)[:4] == b"RIFF"
    published_response.close()
    assert storage.stat(published.storage_key).size_bytes == playlist.size_bytes
    compressed_manifest = client.get(compressed_urls[0]).json()
    assert compressed_manifest["duration_ms"] == 1000
    assert compressed_manifest["segments"][0]["content_type"] == "audio/mpeg"
    assert compressed_segment.frames == 16000
    assert compressed_segment.duration_ms == compressed_playlist.duration_ms == 1000
    assert client.get(compressed_urls[2]).json()["position_ms"] == 500
    compressed_context = client.get(compressed_urls[3]).json()
    assert compressed_context["document_version"]["id"] == str(old_version.pk)
    assert compressed_context["position_ms"] == 500
    compressed_bytes = storage.read_bytes(
        compressed_segment.storage_key, max_bytes=compressed_segment.size_bytes
    )
    assert len(compressed_bytes) == compressed_playlist.size_bytes
    compressed_head = client.head(compressed_urls[1])
    assert compressed_head.status_code == 200
    assert compressed_head["Content-Type"] == "audio/mpeg"
    assert int(compressed_head["Content-Length"]) == len(compressed_bytes)
    compressed_response = client.get(compressed_urls[1], HTTP_RANGE="bytes=0-43")
    assert compressed_response.status_code == 206
    assert b"".join(compressed_response.streaming_content) == compressed_bytes[:44]
    compressed_response.close()
    compressed_replay = client.post(
        "/api/memos/",
        {
            "client_id": str(compressed_memo.submission.client_id),
            "audio_version": str(compressed_playlist.pk),
            "position_ms": 500,
            "duration_ms": 500,
            "text": "Synthetic compressed old PDF context",
            "audio": SimpleUploadedFile(
                "fixture.wav", pcm.getvalue(), content_type="audio/wav"
            ),
        },
    )
    assert compressed_replay.status_code == 200
    assert compressed_replay.json()["id"] == str(compressed_memo.pk)
    assert VoiceMemo.objects.count() == MemoSubmission.objects.count() == 4
    assert sum(path.is_file() for path in media_root.rglob("*")) == file_count
    assert (
        client.get(f"/api/narrations/{narration.pk}/").json()["completed_segments"] == 1
    )
    pdf_response = client.get(f"/api/pdf-imports/{pdf_import.pk}/source/")
    assert pdf_response.status_code == 200
    assert b"".join(pdf_response.streaming_content).startswith(b"%PDF-")
    pdf_response.close()
    progress_response = client.get(f"/api/audio/{audio.pk}/progress/")
    assert progress_response.status_code == 200
    assert progress_response.json()["position_ms"] == 12345
    assert progress_response.json()["revision"] == 1
    restored = client.get(f"/api/memos/{memo.pk}/")
    assert restored.status_code == 200 and restored.json()["position_ms"] == 1234
    response = client.get(f"/api/memos/{memo.pk}/content/", HTTP_RANGE="bytes=0-43")
    assert response.status_code == 206
    payload = b"".join(response.streaming_content)
    assert len(payload) == 44 and payload[:4] == b"RIFF" and payload[8:12] == b"WAVE"
    response.close()
    assert storage.stat(audio.storage_key).size_bytes == audio.size_bytes
    assert storage.stat(memo.storage_key).size_bytes == memo.size_bytes
    assert (
        storage.stat(pdf_import.storage_key).size_bytes == pdf_import.source_size_bytes
    )
    # Dump/restore must retain the complete 0010 profile, old text/timeline and
    # both replay receipts, rather than merely preserving decodable WAV bytes.
    voicevox_version = document.versions.get(number=1)
    assert document.versions.first().number == 2
    assert (
        voicevox_audio.document_version_id
        == voicevox_job.document_version_id
        == voicevox_job.version_id_snapshot
        == voicevox_version.pk
    )
    assert voicevox_job.document_id_snapshot == document.pk
    assert (
        voicevox_job.reading_text
        == voicevox_version.text
        == ("復元確認用の架空の資料です。個人の録音は使っていません。")
    )
    assert voicevox_job.audio_version_id == voicevox_audio.pk
    assert voicevox_job.state == "succeeded"
    assert voicevox_job.voice_settings == VOICEVOX_VOICE
    assert (
        voicevox_job.synthesis_profile
        == voicevox_audio.synthesis_profile
        == (VOICEVOX_PROFILE)
    )
    assert voicevox_job.profile_hash == profile_hash(VOICEVOX_PROFILE)
    assert (
        voicevox_receipt.owner_id
        == voicevox_job.owner_id
        == voicevox_memo.submission.owner_id
        == voicevox_audio.document_version.document.owner_id
        == alice.pk
    )
    assert voicevox_receipt.operation == "start"
    assert voicevox_memo.position_ms == 50 and voicevox_memo.duration_ms == 500
    assert client.get(voicevox_urls[1]).json()["position_ms"] == 60
    voicevox_context = client.get(voicevox_urls[3]).json()
    assert voicevox_context["document_version"]["id"] == str(voicevox_version.pk)
    assert voicevox_context["position_ms"] == 50
    voicevox_map = client.get(voicevox_urls[2]).json()
    assert voicevox_map["document_version"] == str(voicevox_version.pk)
    assert voicevox_map["segments"][0]["start_ms"] == 0
    assert voicevox_map["segments"][0]["end_ms"] == 100
    voicevox_data = storage.read_bytes(
        voicevox_audio.storage_key, max_bytes=voicevox_audio.size_bytes
    )
    with wave.open(io.BytesIO(voicevox_data), "rb") as sound:
        assert (sound.getnchannels(), sound.getsampwidth(), sound.getframerate()) == (
            1,
            2,
            16000,
        )
        assert sound.getnframes() == 1600
        assert sound.readframes(1601) == b"\0\0" * 1600
    voicevox_response = client.get(voicevox_urls[0], HTTP_RANGE="bytes=0-43")
    assert voicevox_response.status_code == 206
    assert b"".join(voicevox_response.streaming_content) == voicevox_data[:44]
    voicevox_response.close()
    before_replay = (
        NarrationJob.objects.count(),
        NarrationRequest.objects.count(),
        AudioVersion.objects.count(),
        sum(path.is_file() for path in media_root.rglob("*")),
    )
    with (
        override_settings(VOICEVOX_ENABLED=False),
        patch("capture.voicevox_provider.catalog") as catalog,
        patch("capture.voicevox_provider.synthesize") as synthesize,
        patch("capture.narration_provider.boto3.client") as aws,
    ):
        replay = client.post(
            voicevox_start_url,
            data=json.dumps(voicevox_request),
            content_type="application/json",
        )
        assert replay.status_code == 200
        assert replay.json()["id"] == str(voicevox_job.pk)
        assert replay.json()["audio_version"] == str(voicevox_audio.pk)
        assert replay.json()["synthesis_profile"] == VOICEVOX_PROFILE
        mismatch = client.post(
            voicevox_start_url,
            data=json.dumps(
                voicevox_request | {"voice": VOICEVOX_VOICE | {"pitch_scale": 0.09}}
            ),
            content_type="application/json",
        )
        assert mismatch.status_code == 409
        catalog.assert_not_called()
        synthesize.assert_not_called()
        aws.assert_not_called()
    assert before_replay == (
        NarrationJob.objects.count(),
        NarrationRequest.objects.count(),
        AudioVersion.objects.count(),
        sum(path.is_file() for path in media_root.rglob("*")),
    )
    voicevox_memo_replay = client.post(
        "/api/memos/",
        {
            "client_id": str(voicevox_memo.submission.client_id),
            "audio_version": str(voicevox_audio.pk),
            "position_ms": 50,
            "duration_ms": 500,
            "text": "Synthetic VOICEVOX old context",
            "audio": SimpleUploadedFile(
                "fixture.wav", pcm.getvalue(), content_type="audio/wav"
            ),
        },
    )
    assert voicevox_memo_replay.status_code == 200
    assert voicevox_memo_replay.json()["id"] == str(voicevox_memo.pk)
    assert VoiceMemo.objects.count() == MemoSubmission.objects.count() == 4
    assert sum(path.is_file() for path in media_root.rglob("*")) == file_count
    # pg_restore must restore the DB guards, not just the profile column values.
    for queryset, values in (
        (
            AudioVersion.objects.filter(pk=voicevox_audio.pk),
            {"synthesis_profile": {}},
        ),
        (
            NarrationJob.objects.filter(pk=voicevox_job.pk),
            {"voice_settings": VOICEVOX_VOICE | {"pitch_scale": 0.09}},
        ),
    ):
        try:
            with transaction.atomic():
                queryset.update(**values)
        except IntegrityError:
            pass
        else:
            raise AssertionError("Restored synthesis provenance guard is missing")
    voicevox_job.refresh_from_db()
    voicevox_audio.refresh_from_db()
    assert voicevox_job.voice_settings == VOICEVOX_VOICE
    assert (
        voicevox_job.synthesis_profile
        == voicevox_audio.synthesis_profile
        == (VOICEVOX_PROFILE)
    )
    call_command("migrate", check_unapplied=True, interactive=False, verbosity=0)
    return {
        "restored_users": 2,
        "memos": 4,
        "owner_denials": 26,
        "anonymous_denials": 17,
        "range_bytes": len(payload),
        "migrations_current": True,
        "progress_position_ms": 12345,
        "progress_revision": 1,
        "pending_pdf_sources": 1,
        "retained_narration_partials": 1,
        "published_playlist_segments": 2,
        "published_mp3_segments": 1,
        "mp3_logical_duration_ms": 1000,
        "mp3_progress_position_ms": 500,
        "mp3_range_verified": True,
        "mp3_memo_replay_idempotent": True,
        "playlist_progress_position_ms": 50,
        "pdf_selection_receipts": 1,
        "confirmed_pdf_sources": 1,
        "pdf_replays_idempotent": True,
        "pdf_changed_replay_rejected": True,
        "old_context_playlist_memos": 2,
        "playlist_memo_replay_idempotent": True,
        "synthetic_voicevox_profiles": 1,
        "voicevox_profile_hash_verified": True,
        "voicevox_narration_replay_without_engine": True,
        "voicevox_changed_profile_replay_rejected": True,
        "voicevox_memo_replay_idempotent": True,
        "voicevox_progress_position_ms": 60,
        "voicevox_old_context_position_ms": 50,
        "voicevox_wav_decode_verified": True,
        "voicevox_restored_profile_guards_verified": True,
    }


def child_stage(database, media_root, action):
    command = [
        sys.executable,
        __file__,
        "--stage",
        action,
        "--database",
        database,
        "--media-root",
        str(media_root),
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if completed.returncode:
        # Full provider/DB exceptions must not accidentally leak credentials or rows.
        raise RuntimeError(f"Synthetic recovery stage failed: {action}")
    return json.loads(completed.stdout)


def drill():
    suffix = secrets.token_hex(8)
    source_db, target_db = f"lc_restore_src_{suffix}", f"lc_restore_dst_{suffix}"
    directory = ROOT / ".local" / f"recovery-drill-{suffix}"
    directory.mkdir(parents=True, mode=0o700)
    source_media, restored_media = (
        directory / "synthetic-media",
        directory / "restored-media",
    )
    archive = directory / "backup"
    created = []
    started = time.perf_counter()
    result = {
        "synthetic_only": True,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "ok": False,
    }
    try:
        create_disposable_database(source_db)
        created.append(source_db)
        result["seed"] = child_stage(source_db, source_media, "seed")
        # A backup cannot claim success when a real DB reference has lost its
        # file. Move only this drill's synthetic audio outside its media root.
        missing = next(path for path in source_media.rglob("*") if path.is_file())
        held = directory / "held-synthetic-audio"
        missing.rename(held)
        try:
            try:
                backup_pair(
                    source_db,
                    source_media,
                    directory / "missing-media-backup",
                    quiesced=True,
                )
            except ValueError as error:
                if "references missing private media" not in str(error):
                    raise
                result["missing_referenced_media_rejected"] = True
            else:
                raise AssertionError("Backup accepted a missing DB-referenced file")
        finally:
            held.rename(missing)
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        manifest = backup_pair(
            source_db, source_media, archive, quiesced=True, commit=commit
        )
        result["backup_files"] = len(manifest["media"])
        # A corrupted file must be rejected before creating any restore database.
        first = archive / "media" / manifest["media"][0]["key"]
        original = first.read_bytes()
        first.write_bytes(original + b"corruption-probe")
        try:
            verify_pair(archive)
        except ValueError:
            result["corrupt_media_rejected"] = True
        else:
            raise AssertionError("Corrupt backup was accepted")
        first.write_bytes(original)
        restore_started = time.perf_counter()
        restore_pair(archive, target_db, restored_media, confirm_disposable=True)
        created.append(target_db)
        result["restore_seconds"] = round(time.perf_counter() - restore_started, 3)
        result["verify"] = child_stage(target_db, restored_media, "verify")
        for entry in manifest["media"]:
            assert sha256(restored_media / entry["key"]) == entry["sha256"]
        # Refusal must happen before any filesystem mutation or DB overwrite.
        try:
            restore_pair(
                archive,
                target_db,
                directory / "another-target",
                confirm_disposable=True,
            )
        except ValueError:
            result["existing_database_rejected"] = True
        else:
            raise AssertionError("Existing database was overwritten")
        result["ok"] = True
    except Exception as error:
        result["error_type"] = type(error).__name__
        raise
    finally:
        # Only names successfully created by this invocation are dropped.
        for database in reversed(created):
            try:
                drop_disposable_database(database)
            except Exception:
                result.setdefault("cleanup_failed", []).append(database)
        result["total_seconds"] = round(time.perf_counter() - started, 3)
        result["finished_at"] = datetime.now(timezone.utc).isoformat()
        (directory / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(result, ensure_ascii=False))
        print(f"Synthetic drill evidence: {directory / 'result.json'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-disposable", action="store_true")
    parser.add_argument("--stage", choices=["seed", "verify"], help=argparse.SUPPRESS)
    parser.add_argument("--database", help=argparse.SUPPRESS)
    parser.add_argument("--media-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    load_env()
    if args.stage:
        print(json.dumps(stage(args.database, args.media_root, args.stage)))
        return
    if not args.confirm_disposable:
        parser.error(
            "--confirm-disposable is required; this creates synthetic test databases"
        )
    drill()


if __name__ == "__main__":
    main()
