"""Account-scoped resume positions, with server revisions instead of client clocks."""

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import ValidationError

from .models import AudioVersion, Document, PlaybackProgress


class ProgressConflict(Exception):
    def __init__(self, progress):
        self.progress = progress
        super().__init__("Playback progress revision changed")


def owned_audio(owner, audio_id):
    return get_object_or_404(
        AudioVersion.objects.select_related("document_version").defer(
            "document_version__text"
        ),
        id=audio_id,
        document_version__document__owner=owner,
    )


def snapshot(audio_id, row=None):
    return {
        "audio_version": str(audio_id),
        "position_ms": row.position_ms if row else 0,
        "revision": row.revision if row else 0,
        "updated_at": row.updated_at.isoformat() if row else None,
    }


def read(owner, audio_id):
    audio = owned_audio(owner, audio_id)
    return snapshot(audio.id, PlaybackProgress.objects.filter(pk=audio.id).first())


@transaction.atomic
def update(owner, audio_id, values):
    # The document lock shares ordering with memo creation and document deletion.
    # The audio lock also serializes the FIRST insert, when no progress row exists.
    # Browser timestamps are deliberately ignored: another device's clock may drift.
    audio = owned_audio(owner, audio_id)
    get_object_or_404(
        Document.objects.select_for_update(),
        id=audio.document_version.document_id,
        owner=owner,
    )
    audio = get_object_or_404(
        AudioVersion.objects.select_for_update(),
        id=audio_id,
        document_version__document__owner=owner,
    )
    if values["position_ms"] > audio.duration_ms:
        raise ValidationError(
            {"position_ms": "再生位置が資料音声の長さを超えています。"}
        )
    row = PlaybackProgress.objects.filter(pk=audio.id).first()
    current_revision = row.revision if row else 0
    if row and row.last_client_id == values["client_id"]:
        # Lost HTTP responses are safe to retry. Never reapply an old seek after
        # a later write; an older request receives the current snapshot as 409.
        if (
            row.revision == values["revision"] + 1
            and row.position_ms == values["position_ms"]
        ):
            return snapshot(audio.id, row)
        raise ProgressConflict(snapshot(audio.id, row))
    if current_revision != values["revision"]:
        raise ProgressConflict(snapshot(audio.id, row))
    if row is None:
        row = PlaybackProgress(audio_version=audio)
    row.position_ms = values["position_ms"]
    row.revision = current_revision + 1
    row.last_client_id = values["client_id"]
    row.save()
    return snapshot(audio.id, row)
