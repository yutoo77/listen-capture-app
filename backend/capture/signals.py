from django.db import transaction
from django.db.models.signals import post_delete, pre_delete
from django.utils import timezone
from django.dispatch import receiver

from .models import (
    AudioSegment,
    AudioVersion,
    Document,
    DocumentVersion,
    GenerationJob,
    PdfImport,
    VoiceMemo,
)
from .storage import delete_key


@receiver(post_delete, sender=VoiceMemo)
@receiver(post_delete, sender=AudioSegment)
@receiver(post_delete, sender=AudioVersion)
@receiver(post_delete, sender=PdfImport)
def remove_private_file_after_commit(sender, instance, **kwargs):
    if instance.storage_key:
        transaction.on_commit(lambda key=instance.storage_key: delete_key(key))


@receiver(pre_delete, sender=Document)
def remove_confirmed_pdf_original(sender, instance, **kwargs):
    from .pdf_imports import _purge_locked

    for job in PdfImport.objects.select_for_update().filter(
        confirmed_document=instance
    ):
        _purge_locked(job, "parent_deleted")


@receiver(pre_delete, sender=DocumentVersion)
def cancel_jobs_for_deleted_version(sender, instance, **kwargs):
    GenerationJob.objects.filter(
        document_version=instance, state__in=["queued", "running", "succeeded"]
    ).update(
        state="failed",
        error_code="parent_deleted",
        lease_token=None,
        lease_expires_at=None,
        updated_at=timezone.now(),
    )
