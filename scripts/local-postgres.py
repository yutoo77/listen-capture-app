"""Optional native Windows runtime helper; PostgreSQL binaries are not committed.

Default supported setup is Docker Compose. This helper only uses locally supplied
EDB binaries under .runtime/postgres/pgsql, binds loopback, and never installs a service.
"""

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("local_env", ROOT / "scripts/manage.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.load_env()
BIN = ROOT / ".runtime/postgres/pgsql/bin"
DATA = ROOT / ".local/postgres-data"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def run(binary, *args):
    subprocess.run(
        [str(BIN / (binary + (".exe" if os.name == "nt" else ""))), *map(str, args)],
        check=True,
        creationflags=FLAGS,
    )


def start():
    (ROOT / ".local").mkdir(exist_ok=True)
    if not DATA.exists():
        handle, password_file = tempfile.mkstemp(prefix="lc-pg-")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as target:
                target.write(os.environ["POSTGRES_PASSWORD"] + "\n")
            run(
                "initdb",
                "-D",
                DATA,
                "-U",
                os.environ["POSTGRES_USER"],
                "--encoding=UTF8",
                "--locale=C",
                "--auth=scram-sha-256",
                f"--pwfile={password_file}",
            )
        finally:
            Path(password_file).unlink(missing_ok=True)
    status = subprocess.run(
        [str(BIN / "pg_ctl.exe"), "-D", str(DATA), "status"],
        capture_output=True,
        creationflags=FLAGS,
    )
    if status.returncode:
        port = os.environ.get("POSTGRES_PORT", "54329")
        run(
            "pg_ctl",
            "-D",
            DATA,
            "-l",
            ROOT / ".local/postgres.log",
            "-o",
            f"-h 127.0.0.1 -p {port}",
            "-w",
            "start",
        )
    os.environ["PGPASSWORD"] = os.environ["POSTGRES_PASSWORD"]
    result = subprocess.run(
        [
            str(BIN / "psql.exe"),
            "-h",
            "127.0.0.1",
            "-p",
            os.environ["POSTGRES_PORT"],
            "-U",
            os.environ["POSTGRES_USER"],
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname='listen_capture'",
        ],
        capture_output=True,
        text=True,
        check=True,
        creationflags=FLAGS,
    )
    if result.stdout.strip() != "1":
        run(
            "createdb",
            "-h",
            "127.0.0.1",
            "-p",
            os.environ["POSTGRES_PORT"],
            "-U",
            os.environ["POSTGRES_USER"],
            os.environ["POSTGRES_DB"],
        )
    print(
        "Local PostgreSQL ready on loopback. This development role can create test databases."
    )


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "start":
        start()
    elif len(sys.argv) == 2 and sys.argv[1] in {"stop", "status"}:
        run("pg_ctl", "-D", DATA, "-w", sys.argv[1])
    else:
        raise SystemExit("Usage: python scripts/local-postgres.py start|stop|status")
