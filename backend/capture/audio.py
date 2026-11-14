"""Validate bounded uploads before they enter private storage."""

import json
import math
import subprocess
import tempfile
from pathlib import Path

from django.conf import settings
from rest_framework.exceptions import APIException, ValidationError

MAX_AUDIO_BYTES = 12 * 1024 * 1024


class AudioUnavailable(APIException):
    status_code = 503
    default_detail = (
        "音声の検証環境を利用できません。録音を端末に残して後で再送してください。"
    )


def sniff(data, declared_type):
    declared = declared_type.split(";")[0].lower()
    if data.startswith(b"\x1aE\xdf\xa3") and declared in {"audio/webm", "video/webm"}:
        return "audio/webm", "webm"
    if (
        len(data) >= 12
        and data[4:8] == b"ftyp"
        and declared in {"audio/mp4", "audio/x-m4a"}
    ):
        return "audio/mp4", "m4a"
    if data.startswith(b"OggS") and declared in {"audio/ogg", "application/ogg"}:
        return "audio/ogg", "ogg"
    if (
        data.startswith(b"RIFF")
        and data[8:12] == b"WAVE"
        and declared in {"audio/wav", "audio/x-wav", "audio/wave"}
    ):
        return "audio/wav", "wav"
    if (
        data.startswith(b"ID3") or data[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}
    ) and declared == "audio/mpeg":
        return "audio/mpeg", "mp3"
    raise ValidationError(
        {"audio": "対応する音声形式ではありません（WebM / MP4 / Ogg / WAV / MP3）。"}
    )


def probe_duration(data, suffix, *, max_duration_ms=None):
    temporary = tempfile.NamedTemporaryFile(suffix=f".{suffix}", delete=False)
    try:
        with temporary:
            temporary.write(data)
        # MediaRecorder WebM may omit format duration. Packet timestamps recover it;
        # input bytes and wall time are bounded, no network protocols are permitted.
        # Route probe output to a temporary file rather than unbounded RAM. Inputs
        # with excessive packet metadata are rejected before JSON is loaded.
        with tempfile.TemporaryFile() as metadata:
            result = subprocess.run(
                [
                    settings.FFPROBE_BINARY,
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file,pipe",
                    "-show_entries",
                    "stream=codec_type,duration:format=duration:packet=pts_time,duration_time",
                    "-of",
                    "json",
                    temporary.name,
                ],
                stdout=metadata,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
            if metadata.tell() > 2 * 1024 * 1024:
                raise ValidationError(
                    {"audio": "音声の構造が複雑すぎるため保存できません。"}
                )
            metadata.seek(0)
            probe_output = metadata.read()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        raise AudioUnavailable() from exc
    finally:
        Path(temporary.name).unlink(missing_ok=True)
    try:
        parsed = json.loads(probe_output)
        streams = parsed.get("streams", [])
        if (
            result.returncode
            or len(streams) != 1
            or streams[0].get("codec_type") != "audio"
        ):
            raise ValueError("not one audio stream")
        candidates = []
        for value in [
            parsed.get("format", {}).get("duration"),
            streams[0].get("duration"),
        ]:
            if value not in {None, "N/A"}:
                candidates.append(float(value))
        for packet in parsed.get("packets", []):
            if packet.get("pts_time") is not None:
                candidates.append(
                    float(packet["pts_time"]) + float(packet.get("duration_time", 0))
                )
        duration = max(candidates) if candidates else 0
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("no positive duration")
        duration_ms = math.ceil(duration * 1000)
        if max_duration_ms and duration_ms > max_duration_ms:
            raise ValidationError({"audio": "録音は60秒以内にしてください。"})
        return duration_ms
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValidationError({"audio": "音声ファイルを読み取れません。"}) from exc


def validate_upload(upload):
    if upload.size > MAX_AUDIO_BYTES:
        raise ValidationError({"audio": "録音の上限は12 MiBです。"})
    data = upload.read(MAX_AUDIO_BYTES + 1)
    if not data or len(data) > MAX_AUDIO_BYTES:
        raise ValidationError({"audio": "音声が空か、容量の上限を超えています。"})
    content_type, suffix = sniff(data, upload.content_type or "")
    probe_duration(data, suffix, max_duration_ms=63000)
    return data, content_type, suffix
