"""Opt-in internal VOICEVOX; bounded worker child, no proxy/redirect/fallback.

The engine receives the exact immutable reading text. Character/engine versions
and request-local pitch are frozen before admission, never global engine edits.
"""

import hashlib
import http.client
import io
import json
import math
from pathlib import Path
import re
import socket
import sys
import tempfile
import time
from urllib.parse import urlencode, urlsplit
import wave

from django.conf import settings
from rest_framework.exceptions import ValidationError

from .narration_provider import MAX_SEGMENT_BYTES, ProviderFailure, SAMPLE_RATE

SEGMENT_CHARACTERS = 300
EMPTY_PROFILE_HASH = hashlib.sha256(b"{}").hexdigest()
_catalog_cache = None


def profile_hash(profile):
    return hashlib.sha256(
        json.dumps(
            profile, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def normalize_voice(provider, voice=None):
    if provider != "voicevox":
        if voice not in (None, {}):
            raise ValidationError(
                {"voice": "このサービスには声の調整を指定できません。"}
            )
        return {}
    # A UUID must always describe the same inputs after settings/engine changes.
    # UI defaults are hints only; new VOICEVOX requests must freeze them explicitly.
    if not isinstance(voice, dict) or set(voice) != {"speaker_id", "pitch_scale"}:
        raise ValidationError({"voice": "話者と声の高さを指定してください。"})
    speaker, pitch = voice["speaker_id"], voice["pitch_scale"]
    if (
        type(speaker) is not int
        or not 0 <= speaker <= 100000
        or type(pitch) not in (int, float)
        or not -0.15 <= pitch <= 0.15
        or not math.isfinite(pitch)
    ):
        raise ValidationError({"voice": "話者または声の高さが範囲外です。"})
    # UI steps are hundredths. Canonicalise float/int and negative zero once.
    if abs(pitch * 100 - round(pitch * 100)) > 0.0000001:
        raise ValidationError({"voice": "声の高さは0.01刻みで指定してください。"})
    return {"speaker_id": speaker, "pitch_scale": round(pitch * 100) / 100 or 0.0}


def endpoint():
    url = urlsplit(settings.VOICEVOX_BASE_URL)
    try:
        port = url.port or 50021
    except ValueError as error:
        raise ProviderFailure("tts_disabled") from error
    if (
        url.scheme != "http"
        or url.hostname not in {"127.0.0.1", "::1", "voicevox"}
        or url.username is not None
        or url.password is not None
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
        or not 1 <= port <= 65535
    ):
        raise ProviderFailure("tts_disabled")
    return url.hostname, port


def _request(method, path, *, query=None, payload=None, maximum=2 * 1024**2, timeout=2):
    host, port = endpoint()
    body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request(
            method,
            path + ("?" + urlencode(query) if query else ""),
            body=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, audio/wav",
            },
        )
        response = connection.getresponse()
        if response.status != 200:
            # http.client never follows Location; response bodies are not logged.
            raise ProviderFailure(
                "provider_rejected"
                if 400 <= response.status < 500
                else "provider_unavailable"
            )
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ProviderFailure("audio_invalid")
        return data
    except (socket.timeout, TimeoutError) as error:
        raise ProviderFailure("execution_unknown") from error
    except (OSError, http.client.HTTPException) as error:
        raise ProviderFailure(
            "provider_unavailable" if method == "GET" else "execution_unknown"
        ) from error
    finally:
        connection.close()


def _json(path):
    try:
        return json.loads(_request("GET", path))
    except (ValueError, UnicodeError) as error:
        raise ProviderFailure("provider_unavailable") from error


def catalog(*, fresh=False):
    global _catalog_cache
    if not settings.VOICEVOX_ENABLED:
        raise ProviderFailure("tts_disabled")
    address = endpoint()
    if (
        not fresh
        and _catalog_cache
        and _catalog_cache[0] == address
        and time.monotonic() < _catalog_cache[1]
    ):
        return _catalog_cache[2]
    version, cores, speakers = (
        _json("/version"),
        _json("/core_versions"),
        _json("/speakers"),
    )
    if not isinstance(version, str) or not 1 <= len(version) <= 100:
        raise ProviderFailure("provider_unavailable")
    if (
        not isinstance(cores, list)
        or not 1 <= len(cores) <= 20
        or any(
            not isinstance(core, str)
            or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", core)
            for core in cores
        )
    ):
        raise ProviderFailure("provider_unavailable")
    core = max(cores, key=lambda item: tuple(map(int, item.split("."))))
    if not isinstance(speakers, list) or len(speakers) > 200:
        raise ProviderFailure("provider_unavailable")
    voices, seen = [], set()
    for speaker in speakers:
        if not isinstance(speaker, dict) or not isinstance(speaker.get("styles"), list):
            continue
        if any(
            not isinstance(speaker.get(key), str) or not 1 <= len(speaker[key]) <= 100
            for key in ("name", "speaker_uuid", "version")
        ):
            continue
        for style in speaker["styles"]:
            if not isinstance(style, dict) or style.get("type", "talk") not in {
                "talk",
                "streaming_talk",
            }:
                continue
            identity = style.get("id")
            if (
                type(identity) is not int
                or not 0 <= identity <= 100000
                or identity in seen
                or not isinstance(style.get("name"), str)
                or not 1 <= len(style["name"]) <= 100
            ):
                continue
            seen.add(identity)
            voices.append(
                {
                    "id": identity,
                    "name": speaker["name"],
                    "style": style["name"],
                    "credit": "VOICEVOX:" + speaker["name"],
                    "speaker_uuid": speaker["speaker_uuid"],
                    "speaker_version": speaker["version"],
                }
            )
    if not voices or len(voices) > 1000:
        raise ProviderFailure("provider_unavailable")
    result = {"engine_version": version, "core_version": core, "voices": voices}
    _catalog_cache = (address, time.monotonic() + 15, result)
    return result


def synthesis_profile(voice, *, available=None):
    available = catalog() if available is None else available
    option = next(
        (item for item in available["voices"] if item["id"] == voice["speaker_id"]),
        None,
    )
    if option is None:
        raise ValidationError(
            {"voice": "選んだ話者は利用できません。一覧を再確認してください。"}
        )
    return {
        "provider": "voicevox",
        "engine_version": available["engine_version"],
        "core_version": available["core_version"],
        "speaker_id": option["id"],
        "speaker_uuid": option["speaker_uuid"],
        "speaker_version": option["speaker_version"],
        "name": option["name"],
        "style": option["style"],
        "credit": option["credit"],
        "pitch_scale": voice["pitch_scale"],
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
    }


def configuration():
    result = {
        "id": "voicevox",
        "enabled": False,
        "label": "VOICEVOX 日本語",
        "voice": "VOICEVOX",
        "billable": False,
        "voices": [],
        "defaults": {"speaker_id": settings.VOICEVOX_SPEAKER_ID, "pitch_scale": 0.0},
        "pitch_min": -0.15,
        "pitch_max": 0.15,
        "pitch_step": 0.01,
        "segment_max_characters": SEGMENT_CHARACTERS,
        "terms_url": "https://voicevox.hiroshiba.jp/term/",
    }
    if settings.VOICEVOX_ENABLED:
        try:
            choices = catalog()["voices"]
            default_id = settings.VOICEVOX_SPEAKER_ID
            if not any(item["id"] == default_id for item in choices):
                default_id = choices[0]["id"]
            result.update(
                enabled=True,
                voices=choices,
                defaults={"speaker_id": default_id, "pitch_scale": 0.0},
            )
        except ProviderFailure:
            pass
    return result


def _pcm(text, profile):
    voice = normalize_voice(
        "voicevox", {key: profile.get(key) for key in ("speaker_id", "pitch_scale")}
    )
    if synthesis_profile(voice, available=catalog(fresh=True)) != profile:
        raise ProviderFailure("provider_rejected")
    query = {"speaker": voice["speaker_id"], "core_version": profile["core_version"]}
    try:
        audio_query = json.loads(
            _request("POST", "/audio_query", query=query | {"text": text}, timeout=10)
        )
        if not isinstance(audio_query, dict):
            raise ProviderFailure("audio_invalid")
        audio_query.update(
            pitchScale=voice["pitch_scale"],
            outputSamplingRate=SAMPLE_RATE,
            outputStereo=False,
        )
        data = _request(
            "POST",
            "/synthesis",
            query=query,
            payload=audio_query,
            maximum=MAX_SEGMENT_BYTES + 65536,
            timeout=100,
        )
        with wave.open(io.BytesIO(data), "rb") as sound:
            if (
                sound.getnchannels(),
                sound.getsampwidth(),
                sound.getframerate(),
                sound.getcomptype(),
            ) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ProviderFailure("audio_invalid")
            frames = sound.getnframes()
            if not 1 <= frames <= MAX_SEGMENT_BYTES // 2:
                raise ProviderFailure("audio_invalid")
            pcm = sound.readframes(frames + 1)
            if len(pcm) != frames * 2:
                raise ProviderFailure("audio_invalid")
            return pcm
    except (ValueError, UnicodeError, wave.Error, EOFError) as error:
        raise ProviderFailure("audio_invalid") from error


def synthesize(text, profile):
    """A hard 120s lifetime also bounds slowly trickling engine responses."""
    from .narration_provider import _bounded_child
    import os
    import subprocess
    import sysconfig

    if not settings.VOICEVOX_ENABLED:
        raise ProviderFailure("tts_disabled")
    if not 1 <= len(text) <= SEGMENT_CHARACTERS:
        raise ProviderFailure("audio_invalid")
    try:
        with tempfile.TemporaryDirectory(prefix="lc-voicevox-") as folder:
            source, output = Path(folder) / "input.json", Path(folder) / "output.pcm"
            source.write_text(
                json.dumps({"text": text, "profile": profile}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.chmod(source, 0o600)
            bootstrap = "import sys,runpy;gate=sys.stdin.buffer.read(1);sys.path[:0]=sys.argv[1:3];sys.argv=['capture.voicevox_provider',*sys.argv[3:]];gate==b'1' and runpy.run_module('capture.voicevox_provider',run_name='__main__')"
            env = {
                key: value
                for key, value in os.environ.items()
                if key.upper()
                in {
                    "PATH",
                    "SYSTEMROOT",
                    "WINDIR",
                    "TEMP",
                    "TMP",
                    "LANG",
                    "LC_ALL",
                    "DJANGO_SETTINGS_MODULE",
                    "DJANGO_SECRET_KEY",
                }
            }
            env.update(
                DJANGO_SETTINGS_MODULE="config.settings",
                DJANGO_SECRET_KEY=settings.SECRET_KEY,
                VOICEVOX_ENABLED="1",
                VOICEVOX_BASE_URL=settings.VOICEVOX_BASE_URL,
                VOICEVOX_SPEAKER_ID=str(settings.VOICEVOX_SPEAKER_ID),
                AWS_EC2_METADATA_DISABLED="true",
                POLLY_ENABLED="0",
                POLLY_BILLING_APPROVED="0",
            )
            result = _bounded_child(
                [
                    getattr(sys, "_base_executable", sys.executable)
                    if os.name == "nt"
                    else sys.executable,
                    "-I",
                    "-c",
                    bootstrap,
                    sysconfig.get_paths()["purelib"],
                    str(settings.BASE_DIR),
                    str(source),
                    str(output),
                ],
                timeout=120,
                env=env,
                cwd=str(settings.BASE_DIR),
            )
            if result.returncode:
                raise ProviderFailure(
                    {
                        40: "provider_rejected",
                        42: "tts_disabled",
                        44: "audio_invalid",
                    }.get(result.returncode, "execution_unknown")
                )
            if not output.exists() or output.stat().st_size > MAX_SEGMENT_BYTES:
                raise ProviderFailure("audio_invalid")
            return output.read_bytes()
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ProviderFailure("execution_unknown") from error


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or not settings.VOICEVOX_ENABLED:
            raise ProviderFailure("tts_disabled")
        source, output = Path(sys.argv[1]), Path(sys.argv[2])
        if source.stat().st_size > 65536:
            raise ProviderFailure("audio_invalid")
        values = json.loads(source.read_bytes())
        if not 1 <= len(values["text"]) <= SEGMENT_CHARACTERS:
            raise ProviderFailure("audio_invalid")
        output.write_bytes(_pcm(values["text"], values["profile"]))
    except ProviderFailure as error:
        raise SystemExit(
            {"provider_rejected": 40, "tts_disabled": 42, "audio_invalid": 44}.get(
                error.code, 41
            )
        ) from None
    except Exception:
        raise SystemExit(41) from None
