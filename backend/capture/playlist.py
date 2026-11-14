"""Canonical owner-scoped timeline for both single and segmented audio."""

from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import AudioSegment, AudioVersion
from .views import stream_private


def source_span(segment, blocks):
    return {
        "start_offset": segment.start_offset,
        "end_offset": segment.end_offset,
        "block_ids": [
            str(block.id)
            for block in blocks
            if block.start_offset < segment.end_offset
            and block.end_offset > segment.start_offset
        ],
    }


def manifest(audio):
    blocks = list(audio.document_version.text_blocks.all())
    if audio.delivery == "playlist":
        segments = [
            {
                "index": segment.index,
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "duration_ms": segment.duration_ms,
                "media_url": f"/api/audio/{audio.id}/segments/{segment.index}/content/",
                "content_type": segment.content_type,
                "size_bytes": segment.size_bytes,
                **source_span(segment, blocks),
            }
            for segment in audio.segments.all()
        ]
    else:
        segments = [
            {
                "index": 0,
                "start_ms": 0,
                "end_ms": audio.duration_ms,
                "duration_ms": audio.duration_ms,
                "media_url": f"/api/audio/{audio.id}/content/",
                "content_type": audio.content_type,
                "size_bytes": audio.size_bytes,
                "start_offset": None,
                "end_offset": None,
                "block_ids": [],
            }
        ]
    return {
        "audio_version": str(audio.id),
        "document_version": str(audio.document_version_id),
        "delivery": audio.delivery,
        "duration_ms": audio.duration_ms,
        "precision": "segment" if audio.delivery == "playlist" else "unavailable",
        "segments": segments,
    }


class PlaylistView(APIView):
    def get(self, request, audio_id):
        audio = get_object_or_404(
            AudioVersion, id=audio_id, document_version__document__owner=request.user
        )
        return Response(manifest(audio))


class SegmentContentView(APIView):
    def get(self, request, audio_id, index):
        segment = get_object_or_404(
            AudioSegment,
            audio_version_id=audio_id,
            index=index,
            audio_version__delivery="playlist",
            audio_version__document_version__document__owner=request.user,
        )
        return stream_private(request, segment)

    head = get
