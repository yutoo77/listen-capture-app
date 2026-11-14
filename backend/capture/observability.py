"""Small, private operator observations; never serializes request bodies or keys."""

from datetime import datetime, timezone
import json
import logging
import shutil


class JsonFormatter(logging.Formatter):
    def format(self, record):
        item = {
            "timestamp": datetime.fromtimestamp(
                record.created, timezone.utc
            ).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": getattr(record, "event", "application"),
        }
        if item["event"] == "http_request":
            for key in ("request_id", "method", "scope", "status", "elapsed_ms"):
                item[key] = getattr(record, key)
        else:
            item["message"] = record.getMessage()
            if record.exc_info:
                item["error_type"] = record.exc_info[0].__name__
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"))


def storage_health(*, max_objects=10000, minimum_free_bytes=1024**3):
    """Bounded stat/DB observation, not a content hash or atomic snapshot.

    Approved S3 performs at most one HEAD per reference; it never lists buckets or
    downloads private content. These requests are not free and must be budgeted.
    """
    from django.conf import settings
    from django.db import DatabaseError
    from django.utils import timezone as django_timezone

    from . import storage
    from .storage_inventory import sources

    result = {
        "checked_at": django_timezone.now().isoformat(),
        "healthy": False,
        "referenced_objects": 0,
        "missing_objects": 0,
        "size_mismatches": 0,
        "metadata_conflicts": 0,
        "free_bytes": None,
        "minimum_free_bytes": minimum_free_bytes,
    }
    if not 1 <= max_objects <= 100000 or minimum_free_bytes < 0:
        raise ValueError("Observation limits must be explicitly bounded")
    try:
        if settings.PRIVATE_STORAGE_BACKEND == "s3":
            storage.validate_s3_configuration()
            disk_root = settings.TTS_CAPACITY_DISK_ROOT
        elif settings.PRIVATE_STORAGE_BACKEND == "local":
            disk_root = settings.PRIVATE_MEDIA_ROOT
        else:
            return result | {"error": "storage_backend_invalid"}
        expected = {}
        for model, size_field in sources():
            rows = (
                model.objects.exclude(storage_key__isnull=True)
                .exclude(storage_key="")
                .values_list("storage_key", size_field)
                .iterator(chunk_size=500)
            )
            for key, size in rows:
                if key in expected and expected[key] != size:
                    result["metadata_conflicts"] += 1
                expected[key] = size
                if len(expected) > max_objects:
                    return result | {"error": "inventory_limit"}
        result["referenced_objects"] = len(expected)
        result["free_bytes"] = shutil.disk_usage(disk_root).free
        for key, size in expected.items():
            try:
                observed = storage.stat(key)
            except storage.StorageMissing:
                result["missing_objects"] += 1
                continue
            result["size_mismatches"] += observed.size_bytes != size
    except (DatabaseError, OSError, ValueError):
        return result | {"error": "storage_or_database_unavailable"}
    result["healthy"] = (
        not result["missing_objects"]
        and not result["size_mismatches"]
        and not result["metadata_conflicts"]
        and result["free_bytes"] >= minimum_free_bytes
    )
    return result
