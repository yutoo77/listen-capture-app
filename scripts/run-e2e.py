"""Seed temporary users per E2E test, then clean up just those users.

Each test gets its own Alice/Bob so account quota and daily generation admission
are exercised without earlier cases consuming the later case's budget. This
does not change application limits or reset billing records. Credentials live in
an ignored temporary file and are never passed as command-line arguments.
"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from manage import load_env  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def collect_test_ids(report):
    """Use Playwright's own IDs, including project/repeat identity and filters."""
    if not isinstance(report, dict) or report.get("errors"):
        raise ValueError("Playwright discovery failed before account creation")
    found = []

    def visit(suites):
        if not isinstance(suites, list):
            raise ValueError("Unexpected Playwright discovery format")
        for suite in suites:
            for spec in suite.get("specs", []):
                identifier = spec.get("id")
                if not isinstance(identifier, str) or not 1 <= len(identifier) <= 200:
                    raise ValueError("Playwright did not provide a bounded test ID")
                found.append(identifier)
            visit(suite.get("suites", []))

    visit(report.get("suites"))
    if not 1 <= len(found) <= 1000 or len(set(found)) != len(found):
        raise ValueError("Expected between 1 and 1000 distinct E2E tests")
    return found


@contextmanager
def seeded_accounts(user_model, test_ids):
    """Own only these newly created IDs, even if seeding or Playwright fails."""
    accounts, created, names = {}, [], []
    try:
        for test_id in test_ids:
            password = secrets.token_urlsafe(24)
            suffix = secrets.token_hex(12)
            pair = {}
            for role in ("alice", "bob"):
                username = f"e2e_{role}_{suffix}"
                user = user_model.objects.create_user(
                    username=username, password=password
                )
                created.append(user.id)
                names.append(username)
                pair[role] = {"username": username, "password": password}
            accounts[test_id] = pair
        yield accounts
    finally:
        if created:
            user_model.objects.filter(id__in=created, username__in=names).delete()


def run(arguments, user_model, *, environment=None):
    environment = dict(os.environ if environment is None else environment)
    # Never use an inherited account set or pass it to the discovery process.
    for key in (
        "LC_E2E_ALICE",
        "LC_E2E_BOB",
        "LC_E2E_PASSWORD",
        "LC_E2E_ACCOUNTS_FILE",
    ):
        environment.pop(key, None)
    command = [
        shutil.which("node") or "node",
        str(ROOT / "node_modules/@playwright/test/cli.js"),
        "test",
        *arguments,
    ]
    listed = subprocess.run(
        [*command, "--list", "--reporter=json"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        encoding="utf-8",
        check=True,
    )
    test_ids = collect_test_ids(json.loads(listed.stdout))
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    with (
        tempfile.TemporaryDirectory(prefix="e2e-accounts-", dir=local) as folder,
        seeded_accounts(user_model, test_ids) as accounts,
    ):
        path = Path(folder) / "accounts.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(accounts, output)
        result = subprocess.run(
            command,
            cwd=ROOT,
            env=environment | {"LC_E2E_ACCOUNTS_FILE": str(path)},
            encoding="utf-8",
        )
    return result.returncode


def main():
    load_env()
    sys.path.insert(0, str(ROOT / "backend"))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django

    django.setup()
    from django.contrib.auth import get_user_model

    return run(sys.argv[1:], get_user_model())


if __name__ == "__main__":
    raise SystemExit(main())
