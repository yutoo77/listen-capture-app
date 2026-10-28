"""Bounded publication encoding. PCM sample counts remain the logical clock.

Only our generated mono s16le/16 kHz PCM enters this module, never uploads or
URLs. Seekable MP3 output keeps the Xing/LAME gapless metadata; a pipe would
lose it. Failed conversion leaves successful provider partials reusable.
"""

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
import tempfile

from django.conf import settings

from .narration_provider import ProviderFailure, SAMPLE_RATE, wave_bytes


@dataclass(frozen=True)
class EncodedAudio:
    data: bytes
    suffix: str
    content_type: str


def _run(arguments):
    try:
        result = subprocess.run(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProviderFailure("audio_encoding_failed") from exc
    if result.returncode:
        raise ProviderFailure("audio_encoding_failed")
    return result.stdout


def _encode(pcm):
    if not pcm or len(pcm) % 2 or len(pcm) > SAMPLE_RATE * 2 * 600:
        raise ProviderFailure("audio_invalid")
    frames = len(pcm) // 2
    # At 16 kHz, LAME's 576-sample frames cannot retain a final 1..46 samples:
    # gapless decode emits at least 47, even for a multi-minute input. Keep the
    # whole bounded asset lossless in that narrow case, just as for tiny tails.
    # WAV costs more bytes, but never pads/trims speech or changes memo clocks.
    # Other MP3 verification failures still fail closed; this is not a fallback
    # for missing Xing metadata, a failed encoder, or an unexpected stream.
    if (
        settings.NARRATION_ENCODING == "wav"
        or frames < 4096
        or (settings.NARRATION_ENCODING == "mp3" and 0 < frames % 576 < 47)
    ):
        return EncodedAudio(wave_bytes(pcm), "wav", "audio/wav")
    if settings.NARRATION_ENCODING != "mp3":
        raise ProviderFailure("audio_encoding_failed")
    with tempfile.TemporaryDirectory(prefix="lc-encode-") as folder:
        source = Path(folder) / "source.pcm"
        target = Path(folder) / "published.mp3"
        decoded = Path(folder) / "verified.pcm"
        source.write_bytes(pcm)
        common = [settings.FFMPEG_BINARY, "-nostdin", "-v", "error", "-y"]
        _run(
            common
            + [
                "-f",
                "s16le",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(source),
                "-map_metadata",
                "-1",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "64k",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-threads",
                "1",
                "-write_xing",
                "1",
                str(target),
            ]
        )
        # 64 kbps plus at most a few headers/MP3 frames. Bound before reading.
        if not target.exists() or not 0 < target.stat().st_size <= len(pcm) // 4 + 4096:
            raise ProviderFailure("audio_encoding_failed")
        metadata = _run(
            [
                settings.FFPROBE_BINARY,
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-show_entries",
                "stream=codec_name,sample_rate,channels",
                "-of",
                "json",
                str(target),
            ]
        )
        try:
            streams = json.loads(metadata)["streams"]
            if len(streams) != 1 or streams[0] != {
                "codec_name": "mp3",
                "sample_rate": str(SAMPLE_RATE),
                "channels": 1,
            }:
                raise ValueError("Unexpected encoded stream")
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderFailure("audio_encoding_failed") from exc
        _run(
            common
            + [
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(target),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "1",
                "-threads",
                "1",
                str(decoded),
            ]
        )
        # FFprobe's padded packet duration must NEVER become the memo clock.
        # Missing/incorrect gapless metadata is a publication failure.
        if not decoded.exists() or decoded.stat().st_size != len(pcm):
            raise ProviderFailure("audio_encoding_failed")
        return EncodedAudio(target.read_bytes(), "mp3", "audio/mpeg")


def encode(pcm):
    try:
        return _encode(pcm)
    except OSError as exc:
        # Disk-full/temp-file failures are local conversion failures, not an
        # unknown provider call. Keep successful PCM and do not bill again.
        raise ProviderFailure("audio_encoding_failed") from exc
