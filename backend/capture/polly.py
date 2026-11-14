"""One billable request at most; retries require a new, budgeted user action."""

import io
import time
import uuid
import wave

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from django.conf import settings

from .tts_config import provider_enabled


def synthesize(text, provider):
    from .generation import GenerationFailure

    if not provider_enabled(provider):
        raise GenerationFailure("tts_disabled")
    if not 1 <= len(text) <= settings.TTS_MAX_CHARACTERS:
        raise GenerationFailure("audio_invalid")
    if provider == "fixture":
        # Intentionally silent synthetic test audio. It never claims to narrate text.
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 8000)
        return output.getvalue(), "audio/wav", "wav"
    client = boto3.client(
        "polly",
        region_name=settings.AWS_REGION,
        use_ssl=True,
        verify=True,
        config=Config(
            ignore_configured_endpoint_urls=True,
            connect_timeout=5,
            read_timeout=45,
            retries={"total_max_attempts": 1, "mode": "standard"},
        ),
    )
    started = time.monotonic()
    try:
        result = client.synthesize_speech(
            Text=text,
            TextType="text",
            OutputFormat="mp3",
            VoiceId="Mizuki",
            LanguageCode="ja-JP",
            Engine="standard",
        )
        stream = result["AudioStream"]
        try:
            chunks, total = [], 0
            while True:
                remaining = 80 - (time.monotonic() - started)
                if remaining <= 0:
                    raise GenerationFailure("execution_unknown")
                if hasattr(stream, "set_socket_timeout"):
                    stream.set_socket_timeout(min(45, remaining))
                chunk = stream.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > 12 * 1024 * 1024:
                    raise GenerationFailure("audio_invalid")
                if time.monotonic() - started > 80:
                    raise GenerationFailure("execution_unknown")
                chunks.append(chunk)
            data = b"".join(chunks)
        finally:
            stream.close()
        return data, "audio/mpeg", "mp3"
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        raise GenerationFailure(
            "provider_unavailable"
            if code in {"ThrottlingException", "ServiceFailureException"}
            else "provider_rejected"
        ) from None
    except (BotoCoreError, OSError):
        # Polly has no idempotency key. A timeout may already have incurred cost.
        raise GenerationFailure("execution_unknown") from None


def generate_audio(version):
    """Compatibility helper: every CLI call uses the same receipt/budget queue."""
    from .generation import Disabled, enqueue

    if not provider_enabled("polly"):
        raise RuntimeError("POLLY_ENABLED=1 and POLLY_BILLING_APPROVED=1 are required")
    try:
        job, _ = enqueue(
            version.document.owner, version.document_id, version.id, uuid.uuid4()
        )
    except Disabled as exc:
        raise RuntimeError(str(exc.detail)) from exc
    return job
