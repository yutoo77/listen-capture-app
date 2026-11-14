"""Explicit providers, all returning signed little-endian mono 16-bit 16 kHz PCM."""

import functools
import io
import math
import os
from pathlib import Path
import subprocess
import struct
import sys
import sysconfig
import tempfile
import wave

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings

from .tts_config import provider_enabled
from .pdf_sandbox import PdfFailure

SAMPLE_RATE = 16000
# Keep new paid requests well below Polly's ten-minute synchronous cutoff.
# Duration remains a separate postcondition: character count cannot prove it.
POLLY_SEGMENT_MAX_CHARACTERS = 1500
POLLY_SEGMENT_MAX_FRAMES = SAMPLE_RATE * 570
MAX_SEGMENT_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 16000 * 2 * 60 * 60
VOICE = "Microsoft Haruka Desktop"
WINDOWS_SCRIPT = r"""
if ([Console]::In.Read() -ne 49) { exit 1 }
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $v = @($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ja-JP' -and $_.VoiceInfo.Name -eq 'Microsoft Haruka Desktop' })
  if ($v.Count -ne 1) { throw 'Japanese development voice unavailable' }
  if ($env:LC_NARRATION_MODE -eq 'probe') { [Console]::Write('ready'); exit 0 }
  $s.SelectVoice('Microsoft Haruka Desktop')
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($env:LC_NARRATION_OUTPUT,$fmt)
  $s.Speak([System.IO.File]::ReadAllText($env:LC_NARRATION_INPUT,[System.Text.Encoding]::UTF8))
  $s.SetOutputToNull()
} finally { $s.Dispose() }
"""


class ProviderFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _bounded_child(command, *, timeout, env=None, cwd=None):
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=cwd,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    def close_job():
        return None

    try:
        if os.name == "nt":
            # The fixed child waits for one stdin byte before accessing source
            # or network. Reuse the PDF sandbox's new one-process lifetime job.
            from .pdf_sandbox import _windows_job

            close_job = _windows_job(process)
        stdout, stderr = process.communicate(input=b"1", timeout=timeout)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    except PdfFailure as exc:
        raise OSError("Child lifetime containment unavailable") from exc
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        close_job()


def _windows(mode, **paths):
    executable = (
        Path(os.environ.get("SystemRoot", "C:/Windows"))
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "LC_ALL"}
    }
    environment.update(LC_NARRATION_MODE=mode, **paths)
    return _bounded_child(
        [str(executable), "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
        env=environment,
        timeout=5 if mode == "probe" else 120,
    )


@functools.lru_cache(maxsize=1)
def installed_windows_voice():
    if os.name != "nt":
        return False
    try:
        result = _windows("probe")
        return (
            result.returncode == 0 and result.stdout.decode("utf-8").strip() == "ready"
        )
    except (OSError, subprocess.TimeoutExpired):
        return False


def enabled(provider):
    if provider == "voicevox":
        return bool(settings.VOICEVOX_ENABLED)
    if provider == "windows":
        return bool(
            settings.DEBUG
            and getattr(settings, "LC_LOCAL_WINDOWS_TTS", False)
            and installed_windows_voice()
        )
    return provider in {"polly", "fixture"} and provider_enabled(provider)


def configuration():
    from . import voicevox_provider

    return {
        "max_characters": 20000,
        "segment_max_characters": 3000,
        "daily_character_limit": settings.TTS_DAILY_USER_CHARACTERS,
        "max_duration_ms": 3600000,
        "fixture_segment_duration_ms": fixture_seconds() * 1000,
        "providers": [
            voicevox_provider.configuration(),
            {
                "id": "polly",
                "enabled": enabled("polly"),
                "label": "Amazon Polly 日本語",
                "voice": "Mizuki",
                "billable": True,
                "segment_max_characters": POLLY_SEGMENT_MAX_CHARACTERS,
            },
            {
                "id": "windows",
                "enabled": enabled("windows"),
                "label": "Windows 日本語音声（開発用）",
                "voice": VOICE,
                "billable": False,
            },
            {
                "id": "fixture",
                "enabled": enabled("fixture"),
                "label": "テスト用の人工音声（本文の合成ではありません）"
                if getattr(settings, "LC_E2E_LONG_AUDIO", False)
                else "テスト用の無音音声",
                "voice": "synthetic-100hz-test-fixture"
                if getattr(settings, "LC_E2E_LONG_AUDIO", False)
                else "silent-test-fixture",
                "billable": False,
            },
        ],
    }


def fixture_seconds():
    if getattr(settings, "LC_E2E_LONG_AUDIO", False):
        seconds = getattr(settings, "LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT", 480)
        if not (enabled("fixture") and 1 <= seconds <= 600):
            raise ProviderFailure("tts_disabled")
        return seconds
    return 3


def synthesize(text, provider):
    if not enabled(provider):
        raise ProviderFailure("tts_disabled")
    if not 1 <= len(text) <= 3000:
        raise ProviderFailure("audio_invalid")
    if provider == "fixture":
        seconds = fixture_seconds()
        if getattr(settings, "LC_E2E_LONG_AUDIO", False):
            # One deterministic 100 Hz period, repeated without per-frame work
            # over long fixtures. This is a test signal, never narrated text.
            period = b"".join(
                struct.pack("<h", round(5000 * math.sin(2 * math.pi * n / 160)))
                for n in range(160)
            )
            return period * (100 * seconds)
        return b"\0\0" * (SAMPLE_RATE * seconds)
    if provider == "windows":
        try:
            with tempfile.TemporaryDirectory(prefix="lc-narration-") as folder:
                source, output = Path(folder) / "input.txt", Path(folder) / "output.wav"
                source.write_text(text, encoding="utf-8")
                os.chmod(source, 0o600)
                result = _windows(
                    "synthesize",
                    LC_NARRATION_INPUT=str(source),
                    LC_NARRATION_OUTPUT=str(output),
                )
                if (
                    result.returncode
                    or not output.exists()
                    or output.stat().st_size > MAX_SEGMENT_BYTES
                ):
                    raise ProviderFailure("provider_unavailable")
                with wave.open(str(output), "rb") as sound:
                    if (
                        sound.getnchannels(),
                        sound.getsampwidth(),
                        sound.getframerate(),
                        sound.getcomptype(),
                    ) != (1, 2, SAMPLE_RATE, "NONE"):
                        raise ProviderFailure("audio_invalid")
                    return sound.readframes(MAX_SEGMENT_BYTES // 2 + 1)
        except subprocess.TimeoutExpired as exc:
            raise ProviderFailure("execution_unknown") from exc
        except (OSError, wave.Error) as exc:
            raise ProviderFailure("provider_unavailable") from exc
    return _polly_process(text)


def _polly_pcm(text):
    """Runs in a dedicated bounded child, including the complete stream read."""
    try:
        client = boto3.client(
            "polly",
            region_name=settings.AWS_REGION,
            use_ssl=True,
            verify=True,
            config=Config(
                ignore_configured_endpoint_urls=True,
                connect_timeout=5,
                read_timeout=90,
                retries={"total_max_attempts": 1},
            ),
        )
        response = client.synthesize_speech(
            Text=text,
            TextType="text",
            OutputFormat="pcm",
            SampleRate="16000",
            VoiceId="Mizuki",
            LanguageCode="ja-JP",
            Engine="standard",
        )
        stream = response["AudioStream"]
        try:
            pcm = stream.read(MAX_SEGMENT_BYTES + 1)
            # Polly cuts off remaining speech at ten minutes without promising
            # a distinct error. Match the legacy API's conservative 9m30s
            # rejection; never label a possibly truncated source as complete.
            if len(pcm) // 2 >= POLLY_SEGMENT_MAX_FRAMES:
                raise ProviderFailure("audio_too_long")
            return pcm
        finally:
            stream.close()
    except ClientError as exc:
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 500)
        raise ProviderFailure(
            "provider_rejected" if 400 <= status < 500 else "execution_unknown"
        ) from exc
    except (BotoCoreError, OSError, KeyError) as exc:
        raise ProviderFailure("execution_unknown") from exc


def _polly_process(text):
    try:
        with tempfile.TemporaryDirectory(prefix="lc-polly-") as folder:
            source, output = Path(folder) / "input.txt", Path(folder) / "output.pcm"
            source.write_text(text, encoding="utf-8")
            os.chmod(source, 0o600)
            # The Windows venv launcher may spawn an unbounded child. Launch
            # the actual interpreter directly and inject only fixed app/libs.
            bootstrap = "import sys,runpy; gate=sys.stdin.buffer.read(1); sys.path[:0]=sys.argv[1:3]; sys.argv=['capture.narration_provider',*sys.argv[3:]]; gate==b'1' and runpy.run_module('capture.narration_provider',run_name='__main__')"
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
                cwd=str(settings.BASE_DIR),
                timeout=120,
            )
            if result.returncode:
                raise ProviderFailure(
                    {
                        40: "provider_rejected",
                        42: "tts_disabled",
                        43: "audio_too_long",
                    }.get(result.returncode, "execution_unknown")
                )
            if not output.exists() or output.stat().st_size > MAX_SEGMENT_BYTES:
                raise ProviderFailure("audio_invalid")
            return output.read_bytes()
    except (OSError, subprocess.TimeoutExpired) as exc:
        # Timeout kills the one child, including a slowly trickling response.
        raise ProviderFailure("execution_unknown") from exc


def wave_bytes(pcm):
    result = io.BytesIO()
    with wave.open(result, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(SAMPLE_RATE)
        sound.writeframes(pcm)
    return result.getvalue()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or not enabled("polly"):
            raise ProviderFailure("tts_disabled")
        source_path, output_path = Path(sys.argv[1]), Path(sys.argv[2])
        if source_path.stat().st_size > 12000:
            raise ProviderFailure("provider_rejected")
        source_text = source_path.read_text(encoding="utf-8")
        if not 1 <= len(source_text) <= 3000:
            raise ProviderFailure("provider_rejected")
        pcm = _polly_pcm(source_text)
        if not pcm or len(pcm) % 2 or len(pcm) > MAX_SEGMENT_BYTES:
            raise ProviderFailure("audio_invalid")
        output_path.write_bytes(pcm)
    except ProviderFailure as error:
        raise SystemExit(
            {"provider_rejected": 40, "tts_disabled": 42, "audio_too_long": 43}.get(
                error.code, 41
            )
        ) from None
    except Exception:
        raise SystemExit(41) from None
