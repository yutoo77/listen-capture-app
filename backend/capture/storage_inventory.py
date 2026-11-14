"""Every durable private-object reference, including unconfirmed PDF originals."""

from .models import AudioSegment, AudioVersion, PdfImport, VoiceMemo
from .narration_models import NarrationSegment


def sources():
    return (
        (AudioVersion, "size_bytes"),
        (AudioSegment, "size_bytes"),
        (VoiceMemo, "size_bytes"),
        (PdfImport, "source_size_bytes"),
        (NarrationSegment, "size_bytes"),
    )


def referenced_keys():
    return {
        key
        for model, _ in sources()
        for key in model.objects.exclude(storage_key__isnull=True)
        .exclude(storage_key="")
        .values_list("storage_key", flat=True)
    }


def is_referenced(key):
    return any(model.objects.filter(storage_key=key).exists() for model, _ in sources())
