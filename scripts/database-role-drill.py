"""Exercise real PostgreSQL runtime privileges in a new synthetic DB only.

Requires the local/CI bootstrap development role to create disposable databases
and roles. Neither existing application DBs nor their permissions are modified.
"""

import argparse
import io
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
import wave

import psycopg
from psycopg import sql

from backup_private import (
    ROOT,
    backup_pair,
    create_disposable_database,
    drop_disposable_database,
    restore_pair,
    sha256,
)
from database_roles import check_runtime, connection, initialize, protect_migrations
from manage import load_env


def runtime_smoke(*, restored=False):
    if not os.environ["POSTGRES_DB"].startswith("lc_restore_roles_"):
        raise ValueError("Runtime smoke requires its disposable database")
    sys.path.insert(0, str(ROOT / "backend"))
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
    import django

    django.setup()
    from django.contrib.auth import get_user_model
    from django.core.files.uploadedfile import SimpleUploadedFile
    from capture import progress, services, storage
    from capture.models import AudioVersion, VoiceMemo

    if restored:
        user = get_user_model().objects.get(username="role_fixture")
        audio, memo = AudioVersion.objects.get(), VoiceMemo.objects.get()
        assert memo.position_ms == 1234
        runtime_reads(user, audio, memo)
        return

    user = get_user_model().objects.create_user(
        "role_fixture", password=secrets.token_urlsafe(24)
    )
    document = services.create_document(
        user, {"title": "Role fixture", "text": "権限分離の確認用です。"}
    )
    sample = (ROOT / "backend/demo/sample.mp3").read_bytes()
    audio = AudioVersion.objects.create(
        document_version=document.versions.first(),
        kind="demo",
        storage_key=storage.put_bytes(sample, "mp3"),
        content_type="audio/mpeg",
        duration_ms=187000,
        size_bytes=len(sample),
    )
    pcm = io.BytesIO()
    with wave.open(pcm, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(16000)
        sound.writeframes(b"\0\0" * 8000)
    memo, created = services.create_memo(
        user,
        {
            "client_id": uuid.uuid4(),
            "audio_version": audio.id,
            "position_ms": 1234,
            "duration_ms": 500,
            "text": "Role fixture",
            "audio": SimpleUploadedFile(
                "synthetic.wav", pcm.getvalue(), content_type="audio/wav"
            ),
        },
    )
    assert created and memo.position_ms == 1234
    progress.update(
        user, audio.id, {"position_ms": 12345, "revision": 0, "client_id": uuid.uuid4()}
    )
    runtime_reads(user, audio, memo)


def runtime_reads(user, audio, memo):
    from django.test import Client

    browser = Client()
    browser.force_login(user)
    assert browser.get(f"/api/memos/{memo.id}/").status_code == 200
    assert (
        browser.get(f"/api/audio/{audio.id}/progress/").json()["position_ms"] == 12345
    )
    response = browser.get(f"/api/memos/{memo.id}/content/", HTTP_RANGE="bytes=0-43")
    assert (
        response.status_code == 206 and len(b"".join(response.streaming_content)) == 44
    )
    response.close()
    browser.logout()
    assert browser.get(f"/api/memos/{memo.id}/").status_code == 403
    print(json.dumps({"runtime_crud_memo_session_range": True}))


def child(arguments, environment):
    completed = subprocess.run(
        [sys.executable, *arguments],
        env=environment,
        cwd=ROOT,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if completed.returncode:
        raise RuntimeError("Synthetic role child failed; no credentials/output exposed")


def expect_permission_denied(runtime, statement):
    try:
        runtime.execute(statement)
    except psycopg.errors.InsufficientPrivilege:
        return
    raise AssertionError("Restricted runtime unexpectedly performed DDL/role operation")


def drill():
    suffix = secrets.token_hex(8)
    database = f"lc_restore_roles_{suffix}"
    restored_database = f"lc_restore_roles_dst_{suffix}"
    directory = ROOT / ".local" / f"database-role-drill-{suffix}"
    directory.mkdir(parents=True, mode=0o700)
    values = dict(os.environ) | {
        "POSTGRES_DB": database,
        "POSTGRES_MIGRATOR_USER": f"lc_migrate_{suffix}",
        "POSTGRES_MIGRATOR_PASSWORD": secrets.token_urlsafe(32),
        "POSTGRES_RUNTIME_USER": f"lc_runtime_{suffix}",
        "POSTGRES_RUNTIME_PASSWORD": secrets.token_urlsafe(32),
    }
    created_db = created_roles = restored_db = False
    result = {"synthetic_only": True, "ok": False}
    started = time.perf_counter()
    try:
        create_disposable_database(database)
        created_db = True
        initialize(values, confirmed=True)
        created_roles = True
        try:
            initialize(values, confirmed=True)
        except ValueError:
            result["existing_roles_refused"] = True
        else:
            raise AssertionError("Existing roles unexpectedly reused")
        runtime_values = values | {
            "POSTGRES_USER": values["POSTGRES_RUNTIME_USER"],
            "POSTGRES_PASSWORD": values["POSTGRES_RUNTIME_PASSWORD"],
        }
        try:
            check_runtime(runtime_values)
        except ValueError:
            result["unmigrated_database_refused"] = True
        else:
            raise AssertionError("Runtime started without migrations")
        shared = values | {
            "DJANGO_DEBUG": "1",
            "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1,testserver",
            "POLLY_ENABLED": "0",
            "POLLY_BILLING_APPROVED": "0",
            "LC_E2E_FIXTURE_TTS": "0",
            "LC_TEST_ENVIRONMENT": "0",
            "AWS_EC2_METADATA_DISABLED": "true",
            "PRIVATE_MEDIA_ROOT": str(directory / "synthetic-media"),
            "PRIVATE_STORAGE_BACKEND": "local",
            "PRIVATE_S3_USE_APPROVED": "0",
        }
        shared.pop("DATABASE_URL", None)
        migrator_values = values | {
            "POSTGRES_USER": values["POSTGRES_MIGRATOR_USER"],
            "POSTGRES_PASSWORD": values["POSTGRES_MIGRATOR_PASSWORD"],
        }
        child(
            ["backend/manage.py", "migrate", "--noinput"],
            shared
            | {
                "POSTGRES_USER": migrator_values["POSTGRES_USER"],
                "POSTGRES_PASSWORD": migrator_values["POSTGRES_PASSWORD"],
            },
        )
        try:
            check_runtime(runtime_values)
        except ValueError:
            result["writable_migration_history_refused"] = True
        else:
            raise AssertionError("Runtime with writable migration history passed guard")
        protect_migrations(migrator_values)
        check_runtime(runtime_values)
        # Also verify the guard refuses the privileged bootstrap role.
        try:
            check_runtime(values)
        except ValueError:
            result["bootstrap_runtime_refused"] = True
        else:
            raise AssertionError("Bootstrap role passed runtime guard")
        with psycopg.connect(
            **connection(migrator_values), autocommit=True
        ) as migrator:
            migrator.execute(
                "CREATE TABLE public.role_probe (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)"
            )
            with psycopg.connect(
                **connection(runtime_values), autocommit=True
            ) as runtime:
                runtime.execute(
                    "INSERT INTO public.role_probe(value) VALUES ('synthetic')"
                )
                runtime.execute("UPDATE public.role_probe SET value='updated'")
                assert runtime.execute(
                    "SELECT value FROM public.role_probe"
                ).fetchone() == ("updated",)
                runtime.execute("DELETE FROM public.role_probe")
                for statement in (
                    "CREATE TABLE public.forbidden(id int)",
                    "CREATE TEMP TABLE forbidden(id int)",
                    "DROP TABLE public.role_probe",
                    "ALTER TABLE public.role_probe ADD COLUMN forbidden int",
                    "DELETE FROM public.django_migrations WHERE false",
                    "UPDATE public.django_migrations SET name=name WHERE false",
                    "INSERT INTO public.django_migrations(app,name,applied) VALUES ('synthetic','forbidden',now())",
                    sql.SQL("SET ROLE {}").format(
                        sql.Identifier(values["POSTGRES_MIGRATOR_USER"])
                    ),
                    sql.SQL("CREATE DATABASE {}").format(
                        sql.Identifier(f"lc_restore_forbidden_{suffix}")
                    ),
                    sql.SQL("CREATE ROLE {}").format(
                        sql.Identifier(f"lc_forbidden_{suffix}")
                    ),
                ):
                    expect_permission_denied(runtime, statement)
                result["forbidden_operations_rejected"] = 10
            migrator.execute(
                sql.SQL("REVOKE UPDATE ON public.role_probe FROM {}").format(
                    sql.Identifier(values["POSTGRES_RUNTIME_USER"])
                )
            )
            try:
                check_runtime(runtime_values)
            except ValueError:
                result["missing_single_crud_permission_refused"] = True
            else:
                raise AssertionError("Missing UPDATE privilege was overlooked")
            migrator.execute(
                sql.SQL("GRANT UPDATE ON public.role_probe TO {}").format(
                    sql.Identifier(values["POSTGRES_RUNTIME_USER"])
                )
            )
            result["future_migration_default_grants"] = True
        check_runtime(runtime_values)
        child(
            ["scripts/database-role-drill.py", "--runtime-smoke"],
            shared
            | {
                "POSTGRES_USER": runtime_values["POSTGRES_USER"],
                "POSTGRES_PASSWORD": runtime_values["POSTGRES_PASSWORD"],
            },
        )
        result["runtime_crud_memo_session_range"] = True
        archive = directory / "backup"
        manifest = backup_pair(
            database,
            directory / "synthetic-media",
            archive,
            quiesced=True,
            commit="synthetic-role-drill",
        )
        for rejected_migrator in (values["POSTGRES_USER"], f"lc_missing_{suffix}"):
            try:
                restore_pair(
                    archive,
                    restored_database,
                    directory / "rejected-media",
                    confirm_disposable=True,
                    migrator_role=rejected_migrator,
                    runtime_role=values["POSTGRES_RUNTIME_USER"],
                )
            except ValueError:
                pass
            else:
                raise AssertionError("Privileged/missing restore role was accepted")
        with psycopg.connect(**(connection(values) | {"dbname": "postgres"})) as admin:
            assert (
                admin.execute(
                    "SELECT 1 FROM pg_database WHERE datname=%s", (restored_database,)
                ).fetchone()
                is None
            )
        result["unsafe_restore_roles_refused_before_db_creation"] = True
        restore_pair(
            archive,
            restored_database,
            directory / "restored-media",
            confirm_disposable=True,
            migrator_role=values["POSTGRES_MIGRATOR_USER"],
            runtime_role=values["POSTGRES_RUNTIME_USER"],
        )
        restored_db = True
        for entry in manifest["media"]:
            assert (
                sha256(directory / "restored-media" / entry["key"]) == entry["sha256"]
            )
        check_runtime(runtime_values | {"POSTGRES_DB": restored_database})
        with psycopg.connect(
            **connection(migrator_values | {"POSTGRES_DB": restored_database}),
            autocommit=True,
        ) as migrator:
            migrator.execute(
                "CREATE TABLE public.after_restore_probe(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)"
            )
        with psycopg.connect(
            **connection(runtime_values | {"POSTGRES_DB": restored_database}),
            autocommit=True,
        ) as runtime:
            runtime.execute("INSERT INTO public.after_restore_probe DEFAULT VALUES")
        result["restored_future_migration_default_grants"] = True
        child(
            ["scripts/database-role-drill.py", "--verify-restored"],
            shared
            | {
                "POSTGRES_USER": runtime_values["POSTGRES_USER"],
                "POSTGRES_PASSWORD": runtime_values["POSTGRES_PASSWORD"],
                "POSTGRES_DB": restored_database,
                "PRIVATE_MEDIA_ROOT": str(directory / "restored-media"),
            },
        )
        result["restricted_backup_restore_runtime_reads"] = True
        result["ok"] = True
    finally:
        # A production restore deliberately retains partial targets. This drill
        # may remove its own partial target only when owned by the random role
        # it created, after checking that the destination did not exist earlier.
        if created_roles and not restored_db:
            with psycopg.connect(
                **(connection(values) | {"dbname": "postgres"})
            ) as admin:
                row = admin.execute(
                    "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=%s",
                    (restored_database,),
                ).fetchone()
                restored_db = row == (values["POSTGRES_MIGRATOR_USER"],)
        if restored_db:
            drop_disposable_database(restored_database)
        if created_db:
            drop_disposable_database(database)
        if created_roles:
            with psycopg.connect(
                **(connection(values) | {"dbname": "postgres"}), autocommit=True
            ) as admin:
                for key in ("POSTGRES_RUNTIME_USER", "POSTGRES_MIGRATOR_USER"):
                    admin.execute(
                        sql.SQL("DROP ROLE {}").format(sql.Identifier(values[key]))
                    )
                assert (
                    admin.execute(
                        "SELECT count(*) FROM pg_database WHERE datname=ANY(%s)",
                        ([database, restored_database],),
                    ).fetchone()[0]
                    == 0
                )
                assert (
                    admin.execute(
                        "SELECT count(*) FROM pg_roles WHERE rolname=ANY(%s)",
                        (
                            [
                                values["POSTGRES_RUNTIME_USER"],
                                values["POSTGRES_MIGRATOR_USER"],
                            ],
                        ),
                    ).fetchone()[0]
                    == 0
                )
                result["disposable_resources_removed"] = True
        result["total_seconds"] = round(time.perf_counter() - started, 3)
        (directory / "result.json").write_text(
            json.dumps(result, indent=2) + "\n", encoding="utf-8"
        )
        print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-disposable", action="store_true")
    parser.add_argument("--runtime-smoke", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--verify-restored", action="store_true", help=argparse.SUPPRESS
    )
    args = parser.parse_args()
    if args.runtime_smoke or args.verify_restored:
        runtime_smoke(restored=args.verify_restored)
        return
    if not args.confirm_disposable:
        parser.error("--confirm-disposable is required; creates synthetic DB/roles")
    load_env()
    drill()


if __name__ == "__main__":
    main()
