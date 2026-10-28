"""Run local integration against disposable DB/media and loopback-only servers.

TTS is an explicitly labeled silent fixture, not a Japanese speech synthesis.
Never changes the active app's database, environment file, media or ports.
"""

import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

from backup_private import create_disposable_database, drop_disposable_database
from manage import load_env

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def ready(url, process):
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError(
                "Loopback test server exited; inspect ignored local logs"
            )
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError("Loopback test server did not become ready")


def main():
    # Playwright emits Unicode; Windows' default cp932 cannot print its arrows.
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    load_env()
    suffix = secrets.token_hex(8)
    database = "lc_restore_e2e_" + suffix
    folder = ROOT / ".local" / ("e2e-run-" + suffix)
    folder.mkdir(parents=True)
    backend_port, frontend_port = free_port(), free_port()
    while frontend_port == backend_port:
        frontend_port = free_port()
    environment = os.environ.copy()
    environment.pop("DATABASE_URL", None)
    environment.update(
        POSTGRES_DB=database,
        PRIVATE_MEDIA_ROOT=str(folder / "media"),
        PRIVATE_STORAGE_BACKEND="local",
        PRIVATE_S3_USE_APPROVED="0",
        DJANGO_DEBUG="1",
        DJANGO_ALLOWED_HOSTS="127.0.0.1,localhost,testserver",
        CSRF_TRUSTED_ORIGINS=f"http://127.0.0.1:{frontend_port}",
        POLLY_ENABLED="0",
        POLLY_BILLING_APPROVED="0",
        LC_E2E_FIXTURE_TTS="1",
        LC_TEST_ENVIRONMENT="1",
        AWS_EC2_METADATA_DISABLED="true",
        PYTHONUNBUFFERED="1",
        LC_E2E_EXPECT_FIXTURE="1",
        LC_BASE_URL=f"http://127.0.0.1:{frontend_port}",
        VITE_PROXY_TARGET=f"http://127.0.0.1:{backend_port}",
        PLAYWRIGHT_HTML_OUTPUT_DIR=str(folder / "playwright-report"),
    )
    # Prevent credentials inherited from a developer's shell reaching test workers.
    for key in list(environment):
        if key.startswith("AWS_") and key not in {
            "AWS_REGION",
            "AWS_EC2_METADATA_DISABLED",
        }:
            environment.pop(key)
    processes = []
    logs = []
    created = False
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        create_disposable_database(database)
        created = True
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/manage.py"), "migrate", "--noinput"],
            env=environment,
            cwd=ROOT,
            check=True,
            creationflags=flags,
        )

        def spawn(name, command, cwd=ROOT):
            output = (folder / (name + ".log")).open("w", encoding="utf-8")
            logs.append(output)
            process = subprocess.Popen(
                command,
                env=environment,
                cwd=cwd,
                stdout=output,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=flags,
            )
            processes.append(process)
            return process

        server = spawn(
            "api",
            [
                sys.executable,
                str(ROOT / "backend/manage.py"),
                "runserver",
                f"127.0.0.1:{backend_port}",
                "--noreload",
            ],
            ROOT / "backend",
        )
        ready(f"http://127.0.0.1:{backend_port}/api/health/", server)
        for worker in ("audio_worker", "pdf_worker", "narration_worker"):
            spawn(
                worker.replace("_", "-"),
                [
                    sys.executable,
                    str(ROOT / "backend/manage.py"),
                    worker,
                    "--poll-seconds",
                    "0.25",
                ],
                ROOT / "backend",
            )
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 24 is required")
        web = spawn(
            "web",
            [
                node,
                str(ROOT / "frontend/node_modules/vite/bin/vite.js"),
                "--host",
                "127.0.0.1",
                "--port",
                str(frontend_port),
            ],
            ROOT / "frontend",
        )
        ready(environment["LC_BASE_URL"], web)
        # Preserve output explicitly: Windows CREATE_NO_WINDOW descendants may
        # not inherit the host terminal, and failures need inspectable evidence.
        with (folder / "e2e.log").open("w", encoding="utf-8") as output:
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/run-e2e.py"),
                    f"--output={folder / 'test-results'}",
                    *sys.argv[1:],
                ],
                env=environment,
                cwd=ROOT,
                stdout=output,
                stderr=subprocess.STDOUT,
                creationflags=flags,
                check=False,
            )
        print((folder / "e2e.log").read_text(encoding="utf-8"))
        return result.returncode
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                if os.name == "nt":
                    # The Windows venv launcher can have a child Python process.
                    # Terminate only this still-live, newly spawned process tree.
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        creationflags=flags,
                    )
                    process.wait(timeout=8)
                    continue
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        for output in logs:
            output.close()
        if created:
            drop_disposable_database(database)
        print(f"Disposable E2E artifacts: {folder}; database removed.")


if __name__ == "__main__":
    raise SystemExit(main())
