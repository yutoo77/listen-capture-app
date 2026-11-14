"""Export an explicitly approved private object store and quiesced DB as one pair.

The output uses backup_private's verified, local-restore format. This does not
create a bucket, alter IAM, upload backups, or claim atomic snapshots of live DB
and S3. Original objects are never deleted. Real execution needs an independent
backup identity and explicit resource/cost approval outside this tool.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

from backup_private import (
    ROOT,
    pg_tool,
    referenced_media,
    safe_relative,
    sha256,
    verify_pair,
)
from manage import load_env


def export_pair(
    database,
    store,
    output,
    *,
    quiesced,
    commit="unknown",
    max_total_bytes=5 * 1024**3,
    max_objects=10000,
):
    if not quiesced:
        raise ValueError("Stop all writers and explicitly confirm quiescence")
    output = Path(output).resolve()
    if output.exists() or max_total_bytes <= 0 or not 1 <= max_objects <= 100000:
        raise ValueError(
            "Use a fresh output directory and explicit bounded export limits"
        )
    references = referenced_media(database)
    items = {}
    total = 0
    for item in store.objects():
        safe_relative(output / "media", item.key)
        if item.key in items or not 0 <= item.size_bytes <= 128 * 1024 * 1024:
            raise ValueError("Invalid or oversized object inventory")
        items[item.key] = item
        total += item.size_bytes
        if len(items) > max_objects or total > max_total_bytes:
            raise ValueError("Object backup exceeds its approved export limits")
    if not references.issubset(items):
        raise ValueError(
            "Object inventory is missing database-referenced private media"
        )
    output.mkdir(parents=True, mode=0o700)
    media = output / "media"
    media.mkdir(mode=0o700)
    started = datetime.now(timezone.utc).isoformat()
    dump = output / "database.dump"
    pg_tool(
        "pg_dump",
        database,
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--file",
        str(dump),
    )
    os.chmod(dump, 0o600)
    entries = []
    for key, item in sorted(items.items()):
        destination = safe_relative(media, key)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        digest, copied = hashlib.sha256(), 0
        with (
            store.open_read(key, length=item.size_bytes, etag=item.etag) as source,
            destination.open("xb") as target,
        ):
            os.chmod(destination, 0o600)
            while chunk := source.read(65536):
                copied += len(chunk)
                if copied > item.size_bytes:
                    raise ValueError("Object grew during backup")
                target.write(chunk)
                digest.update(chunk)
            target.flush()
            os.fsync(target.fileno())
        after = store.stat(key)
        if copied != item.size_bytes or (
            after.size_bytes,
            after.etag,
            after.modified_at,
        ) != (item.size_bytes, item.etag, item.modified_at):
            raise ValueError("Object changed during backup; writers were not quiesced")
        entries.append({"key": key, "size_bytes": copied, "sha256": digest.hexdigest()})
    if referenced_media(database) != references:
        raise ValueError("Database references changed during object backup")
    manifest = {
        "schema": 1,
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "commit": commit,
        "database_sha256": sha256(dump),
        "media": entries,
        "referenced_media": sorted(references),
        "writers_quiesced_by_operator": True,
        "source": "configured-private-object-store",
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest_path, 0o600)
    verify_pair(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--quiesced", action="store_true")
    parser.add_argument("--confirm-configured-object-store", action="store_true")
    parser.add_argument("--commit", default="unknown")
    parser.add_argument("--max-total-bytes", type=int, default=5 * 1024**3)
    parser.add_argument("--max-objects", type=int, default=10000)
    args = parser.parse_args()
    if not args.confirm_configured_object_store or not args.quiesced:
        parser.error(
            "Explicit --confirm-configured-object-store and --quiesced are required"
        )
    if args.output.resolve().is_relative_to(ROOT):
        parser.error("Operational object backups must be outside the source repository")
    load_env()
    sys.path.insert(0, str(ROOT / "backend"))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    try:
        import django

        django.setup()
        from django.conf import settings
        from capture import storage

        if settings.PRIVATE_STORAGE_BACKEND != "s3":
            raise ValueError(
                "Configured object-store export requires the approved S3 backend"
            )
        storage.validate_s3_configuration()
        manifest = export_pair(
            args.database,
            storage,
            args.output,
            quiesced=args.quiesced,
            commit=args.commit,
            max_total_bytes=args.max_total_bytes,
            max_objects=args.max_objects,
        )
    except Exception as error:
        print(
            f"Object backup failed ({type(error).__name__}); no source object was changed.",
            file=sys.stderr,
        )
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "files": len(manifest["media"]),
                "bytes": sum(item["size_bytes"] for item in manifest["media"]),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
