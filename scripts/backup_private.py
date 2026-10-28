"""Private DB+audio backup primitives and guarded CLI.

Only use trusted backups. pg_restore executes SQL from its archive. Writes must
be quiesced externally: stop web/backend/worker while retaining PostgreSQL.
This script does not pretend that pg_dump alone snapshots a filesystem.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

import psycopg
from psycopg import sql

from database_roles import (
    NAME as ROLE_NAME,
    reconcile_restored,
    validate_existing_roles,
)
from manage import load_env

ROOT = Path(__file__).resolve().parents[1]
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
RESTORE_NAME = re.compile(r"lc_restore_[a-z0-9_]{1,40}\Z")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def connection(database="postgres"):
    return dict(
        dbname=database,
        host=os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        port=os.environ.get("POSTGRES_PORT", "54329"),
        user=os.environ.get("POSTGRES_USER", "listen_capture"),
        password=os.environ.get("POSTGRES_PASSWORD", ""),
        connect_timeout=5,
    )


def binary(name):
    supplied = os.environ.get("PG_BIN")
    bundled = ROOT / ".runtime/postgres/pgsql/bin"
    if supplied or bundled.is_dir():
        folder = Path(supplied) if supplied else bundled
        path = folder / (name + (".exe" if os.name == "nt" else ""))
        if not path.is_file():
            raise ValueError(f"Matching PostgreSQL tool is missing: {name}")
        return str(path)
    located = shutil.which(name)
    if not located:
        raise ValueError(f"Install a matching PostgreSQL client or set PG_BIN: {name}")
    return located


def pg_tool(name, database, *arguments):
    config = connection(database)
    environment = os.environ.copy()
    environment["PGPASSWORD"] = config["password"]
    command = [
        binary(name),
        "--host",
        str(config["host"]),
        "--port",
        str(config["port"]),
        "--username",
        config["user"],
        "--no-password",
        *arguments,
        "--dbname",
        database,
    ]
    result = subprocess.run(
        command, env=environment, capture_output=True, creationflags=FLAGS, check=False
    )
    if result.returncode:
        raise RuntimeError(
            f"{name} failed; verify client/server versions and database access"
        )


def safe_relative(root, value):
    relative = PurePosixPath(value)
    if (
        not value
        or "\\" in value
        or relative.is_absolute()
        or any(part in {"..", ".", ""} for part in relative.parts)
        or ":" in value
        or relative.as_posix() != value
    ):
        raise ValueError("Unsafe path in backup manifest")
    path = root.joinpath(*relative.parts)
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
        raise ValueError("Backup path escapes its root")
    return path


def referenced_media(database):
    """Read actual app references; callers must keep all writers quiesced."""
    with psycopg.connect(**connection(database)) as database_connection:
        query = "SELECT storage_key FROM public.capture_audioversion WHERE storage_key IS NOT NULL AND storage_key<>'' UNION SELECT storage_key FROM public.capture_voicememo"
        pdf_table = database_connection.execute(
            "SELECT to_regclass('public.capture_pdfimport')"
        ).fetchone()[0]
        if pdf_table:
            query += " UNION SELECT storage_key FROM public.capture_pdfimport WHERE storage_key IS NOT NULL AND storage_key<>''"
        elif database_connection.execute(
            "SELECT EXISTS(SELECT 1 FROM public.django_migrations WHERE app='capture' AND name LIKE '0005_%')"
        ).fetchone()[0]:
            raise ValueError(
                "PDF schema is incomplete; private reference inventory is unsafe"
            )
        narration_table = database_connection.execute(
            "SELECT to_regclass('public.capture_narrationsegment')"
        ).fetchone()[0]
        if narration_table:
            query += " UNION SELECT storage_key FROM public.capture_narrationsegment WHERE storage_key IS NOT NULL AND storage_key<>''"
        elif database_connection.execute(
            "SELECT EXISTS(SELECT 1 FROM public.django_migrations WHERE app='capture' AND name LIKE '0006_%')"
        ).fetchone()[0]:
            raise ValueError(
                "Narration schema is incomplete; private reference inventory is unsafe"
            )
        published_segments = database_connection.execute(
            "SELECT to_regclass('public.capture_audiosegment')"
        ).fetchone()[0]
        if published_segments:
            query += " UNION SELECT storage_key FROM public.capture_audiosegment"
        elif database_connection.execute(
            "SELECT EXISTS(SELECT 1 FROM public.django_migrations WHERE app='capture' AND name LIKE '0007_%')"
        ).fetchone()[0]:
            raise ValueError(
                "Playlist schema is incomplete; private reference inventory is unsafe"
            )
        return {row[0] for row in database_connection.execute(query).fetchall()}


def backup_pair(database, media_root, output, *, quiesced, commit="unknown"):
    if os.environ.get("PRIVATE_STORAGE_BACKEND", "local") != "local":
        raise ValueError(
            "Filesystem backup requires local storage; use the explicit object-store export"
        )
    if not quiesced:
        raise ValueError(
            "Stop all application writers and explicitly confirm quiescence"
        )
    media_root, output = Path(media_root).resolve(), Path(output).resolve()
    if not media_root.is_dir() or output.exists():
        raise ValueError(
            "Media root must exist and backup output must be a fresh directory"
        )
    if output.is_relative_to(media_root) or media_root.is_relative_to(output):
        raise ValueError("Backup and media roots must be separate")
    references = referenced_media(database)
    if any(not safe_relative(media_root, key).is_file() for key in references):
        raise ValueError(
            "Database references missing private media; backup is incomplete"
        )
    output.mkdir(parents=True, mode=0o700)
    private_copy = output / "media"
    private_copy.mkdir(mode=0o700)
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
    for source in sorted(media_root.rglob("*")):
        if source.is_symlink():
            raise ValueError("Private media must not contain symlinks")
        if not source.is_file():
            continue
        key = source.relative_to(media_root).as_posix()
        destination = safe_relative(private_copy, key)
        before = sha256(source)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, destination)
        os.chmod(destination, 0o600)
        if before != sha256(destination) or before != sha256(source):
            raise ValueError(
                "Media changed during backup; quiescence was not maintained"
            )
        entries.append(
            {"key": key, "size_bytes": source.stat().st_size, "sha256": before}
        )
    if not references.issubset({entry["key"] for entry in entries}):
        raise ValueError("Backup is missing database-referenced private media")
    # These before/after reads detect observed reference changes; they do not
    # make a live DB dump and filesystem copy atomic. Quiescence remains required.
    if referenced_media(database) != references:
        raise ValueError(
            "Media references changed during backup; writers were not quiesced"
        )
    manifest = {
        "schema": 1,
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "commit": commit,
        "database_sha256": sha256(dump),
        "media": entries,
        "referenced_media": sorted(references),
        "writers_quiesced_by_operator": True,
    }
    manifest_path = output / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.chmod(manifest_path, 0o600)
    verify_pair(output)
    return manifest


def verify_pair(backup):
    backup = Path(backup).resolve()
    if (backup / "media").is_symlink():
        raise ValueError("Media backup root must not be a symlink")
    manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or not manifest.get("writers_quiesced_by_operator"):
        raise ValueError("Unsupported or incomplete backup manifest")
    if sha256(backup / "database.dump") != manifest["database_sha256"]:
        raise ValueError("Database backup checksum mismatch")
    seen = set()
    for entry in manifest["media"]:
        if entry["key"] in seen:
            raise ValueError("Duplicate key in manifest")
        seen.add(entry["key"])
        source = safe_relative(backup / "media", entry["key"])
        if not source.is_file() or source.stat().st_size != entry["size_bytes"]:
            raise ValueError("Media backup is incomplete")
        if sha256(source) != entry["sha256"]:
            raise ValueError("Media backup checksum mismatch")
    # Older schema-1 manifests lack this field and retain their earlier, limited
    # file-checksum validation. Every newly created backup records its DB refs.
    if "referenced_media" in manifest:
        references = manifest["referenced_media"]
        if (
            not isinstance(references, list)
            or any(not isinstance(key, str) for key in references)
            or len(set(references)) != len(references)
            or not set(references).issubset(seen)
        ):
            raise ValueError("Backup manifest omits database-referenced private media")
    return manifest


def create_disposable_database(name, *, owner=None):
    if not RESTORE_NAME.fullmatch(name):
        raise ValueError("Only new lc_restore_* databases are allowed")
    if owner is not None and not ROLE_NAME.fullmatch(owner):
        raise ValueError("Restore owner must be a simple role identifier")
    with psycopg.connect(**connection(), autocommit=True) as admin:
        if admin.execute(
            "SELECT 1 FROM pg_database WHERE datname=%s", (name,)
        ).fetchone():
            raise ValueError("Refusing to overwrite an existing restore database")
        statement = sql.SQL(
            "CREATE DATABASE {} TEMPLATE template0 ENCODING 'UTF8'"
        ).format(sql.Identifier(name))
        if owner is not None:
            statement += sql.SQL(" OWNER {}").format(sql.Identifier(owner))
        admin.execute(statement)
        if owner is not None:
            admin.execute(
                sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(
                    sql.Identifier(name)
                )
            )


def drop_disposable_database(name):
    if not RESTORE_NAME.fullmatch(name):
        raise ValueError("Refusing to drop a non-disposable database")
    with psycopg.connect(**connection(), autocommit=True) as admin:
        admin.execute(
            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
        )


def restore_pair(
    backup,
    database,
    media_root,
    *,
    confirm_disposable,
    migrator_role=None,
    runtime_role=None,
):
    if not confirm_disposable:
        raise ValueError("Explicit --confirm-disposable is required")
    if bool(migrator_role) != bool(runtime_role):
        raise ValueError("Restricted restore requires both migration and runtime roles")
    if migrator_role:
        if (
            not ROLE_NAME.fullmatch(migrator_role)
            or not ROLE_NAME.fullmatch(runtime_role)
            or migrator_role == runtime_role
        ):
            raise ValueError(
                "Restricted restore requires distinct simple role identifiers"
            )
        with psycopg.connect(**connection(), autocommit=True) as admin:
            validate_existing_roles(admin, migrator_role, runtime_role)
    manifest = verify_pair(backup)
    media_root, backup = Path(media_root).resolve(), Path(backup).resolve()
    if media_root.exists() or media_root == backup or media_root.is_relative_to(backup):
        raise ValueError("Restore media path must be new and separate from the backup")
    create_disposable_database(database, owner=migrator_role)
    try:
        media_root.mkdir(parents=True, mode=0o700)
        pg_tool(
            "pg_restore",
            database,
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            *(["--role", migrator_role] if migrator_role else []),
            str(backup / "database.dump"),
        )
        for entry in manifest["media"]:
            destination = safe_relative(media_root, entry["key"])
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(safe_relative(backup / "media", entry["key"]), destination)
            os.chmod(destination, 0o600)
        if migrator_role:
            config = connection(database)
            reconcile_restored(
                {
                    "POSTGRES_DB": database,
                    "POSTGRES_HOST": config["host"],
                    "POSTGRES_PORT": config["port"],
                    "POSTGRES_USER": config["user"],
                    "POSTGRES_PASSWORD": config["password"],
                },
                migrator=migrator_role,
                runtime=runtime_role,
            )
        return manifest
    except Exception:
        # Preserve a failed restore for inspection; never overwrite or reuse it.
        raise RuntimeError(
            "Restore failed; disposable target retained for inspection"
        ) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    backup = sub.add_parser("backup")
    backup.add_argument("--database", required=True)
    backup.add_argument("--media-root", type=Path, required=True)
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--quiesced", action="store_true")
    backup.add_argument("--commit", default="unknown")
    restore = sub.add_parser("restore")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--database", required=True)
    restore.add_argument("--media-root", type=Path, required=True)
    restore.add_argument("--confirm-disposable", action="store_true")
    restore.add_argument(
        "--restricted-roles",
        action="store_true",
        help="Restore using existing POSTGRES_MIGRATOR_USER/POSTGRES_RUNTIME_USER and reapply runtime grants",
    )
    args = parser.parse_args()
    load_env()
    try:
        if args.command == "backup":
            if args.output.resolve().is_relative_to(ROOT):
                raise ValueError(
                    "Operational backups must be outside the source repository"
                )
            manifest = backup_pair(
                args.database,
                args.media_root,
                args.output,
                quiesced=args.quiesced,
                commit=args.commit,
            )
        else:
            if args.restricted_roles and not all(
                os.environ.get(key)
                for key in ("POSTGRES_MIGRATOR_USER", "POSTGRES_RUNTIME_USER")
            ):
                raise ValueError(
                    "Restricted restore requires configured migration/runtime role names"
                )
            manifest = restore_pair(
                args.backup,
                args.database,
                args.media_root,
                confirm_disposable=args.confirm_disposable,
                migrator_role=os.environ.get("POSTGRES_MIGRATOR_USER")
                if args.restricted_roles
                else None,
                runtime_role=os.environ.get("POSTGRES_RUNTIME_USER")
                if args.restricted_roles
                else None,
            )
        print(
            json.dumps(
                {
                    "ok": True,
                    "files": len(manifest["media"]),
                    "schema": manifest["schema"],
                }
            )
        )
        return 0
    except (OSError, ValueError, RuntimeError, psycopg.Error) as error:
        print(
            f"Backup/recovery failed ({type(error).__name__}); targets were not overwritten.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
