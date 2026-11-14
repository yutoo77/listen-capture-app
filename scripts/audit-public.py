"""Audit a clean publication tree; print locations/categories, never matched values.

This is a publication guard, not a secret-scanner replacement or security proof.
Use it on the complete clean export, not on a working tree containing test data.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


DENIED_DIRECTORIES = {
    ".aws",
    ".local",
    ".runtime",
    ".terraform",
    ".venv",
    "__pycache__",
    "node_modules",
    "private-media",
    "backups",
    "paired-backups",
    "test-results",
    "playwright-report",
    "coverage",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
}
DENIED_SUFFIXES = {
    ".key",
    ".pem",
    ".pfx",
    ".p12",
    ".crt",
    ".cer",
    ".dump",
    ".sqlite3",
    ".db",
    ".log",
    ".zip",
    ".7z",
    ".tar",
    ".gz",
    ".pyc",
    ".tsbuildinfo",
}
PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "github-token": re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b"
    ),
    "jwt": re.compile(
        r"\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b"
    ),
    "windows-user-path": re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/]+", re.I),
    "unix-user-path": re.compile(r"/(?:Users|home)/[A-Za-z0-9_.-]+/"),
    "private-history-link": re.compile(
        r"https://github\.com/[^\s/]+/listen-capture/(?:pull|commit|actions|tree|blob|releases)/"
    ),
    "aws-account-arn": re.compile(r"arn:aws[^\s:]*:[^\s:]*:[^\s:]*:(\d{12}):"),
    "email": re.compile(r"\b[A-Za-z0-9_.+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b"),
}
SYNTHETIC_ACCOUNTS = {"000000000000", "123456789012", "999999999999"}
SAFE_EMAIL_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "example.test",
    "test.invalid",
    "users.noreply.github.com",
}


def run_git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return result.returncode, result.stdout.strip()


def audit(root, require_initial=False, expected_root=None):
    findings, inventory, binaries = [], [], []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if ".git" in path.relative_to(root).parts:
            continue
        if path.is_symlink():
            findings.append({"path": relative, "kind": "symlink-not-permitted"})
            continue
        parts = set(path.relative_to(root).parts)
        denied = parts & DENIED_DIRECTORIES
        if path.is_dir():
            if path.name in DENIED_DIRECTORIES:
                findings.append(
                    {"path": relative, "kind": "private-or-generated-directory"}
                )
            continue
        if denied:
            continue
        if (
            (path.name.startswith(".env") and path.name != ".env.example")
            or path.suffix.lower() in DENIED_SUFFIXES
            or re.search(r"\.(?:tfstate|tfplan|tfvars)(?:\.|$)", path.name)
            and not path.name.endswith(".example")
            or path.name in {"credentials", "backend.hcl", "plan-review.json"}
        ):
            findings.append({"path": relative, "kind": "private-or-generated-file"})
            continue
        data = path.read_bytes()
        inventory.append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            binaries.append(relative)
            allowed = relative == "backend/demo/sample.mp3" or (
                relative.startswith("docs/images/")
                and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webm"}
            )
            if not allowed:
                findings.append({"path": relative, "kind": "unreviewed-binary"})
            continue
        for line_number, line in enumerate(content.splitlines(), 1):
            for category, pattern in PATTERNS.items():
                for match in pattern.finditer(line):
                    # This negative test rejects a synthetic container credential path.
                    fixture_path = "/".join(("", "home", "app", ".aws", "config"))
                    if (
                        relative == "backend/capture/tests/test_aws_credentials.py"
                        and category == "unix-user-path"
                        and line.strip() == f'("AWS_CONFIG_FILE", "{fixture_path}"),'
                    ):
                        continue
                    if (
                        category == "aws-account-arn"
                        and match.group(1) in SYNTHETIC_ACCOUNTS
                    ):
                        continue
                    if category == "email":
                        domain = match.group().split("@", 1)[1].lower()
                        if domain in SAFE_EMAIL_DOMAINS:
                            continue
                    findings.append(
                        {"path": relative, "line": line_number, "kind": category}
                    )
    history = {"checked": False}
    if require_initial or expected_root:
        code, count = run_git(root, "rev-list", "--all", "--count")
        if require_initial:
            if code != 0 or count != "1":
                findings.append(
                    {"path": ".git", "kind": "expected-single-initial-commit"}
                )
            code, parents = run_git(root, "rev-list", "--parents", "-n", "1", "HEAD")
            if code != 0 or len(parents.split()) != 1:
                findings.append(
                    {"path": ".git", "kind": "expected-parentless-initial-commit"}
                )
        if expected_root:
            root_code, roots = run_git(root, "rev-list", "--max-parents=0", "--all")
            root_matches = root_code == 0 and roots.splitlines() == [
                expected_root.lower()
            ]
            if not root_matches:
                findings.append(
                    {"path": ".git", "kind": "expected-single-reviewed-root"}
                )
        code, remotes = run_git(root, "remote")
        if code != 0 or remotes:
            findings.append(
                {"path": ".git/config", "kind": "unexpected-remote-before-approval"}
            )
        code, emails = run_git(root, "log", "--all", "--format=%ae%n%ce")
        if code != 0 or any(
            not e.endswith("@users.noreply.github.com") for e in emails.splitlines()
        ):
            findings.append({"path": ".git", "kind": "review-commit-identity"})
        code, status = run_git(root, "status", "--porcelain", "--untracked-files=all")
        if code != 0 or status:
            findings.append({"path": ".git", "kind": "uncommitted-publication-files"})
        history = {"checked": True, "single_commit": count == "1"}
        if expected_root:
            history["expected_root"] = expected_root.lower()
            history["root_matches"] = root_matches
    return {
        "status": "pass" if not findings else "fail",
        "files": len(inventory),
        "bytes": sum(item["bytes"] for item in inventory),
        "findings": findings,
        "binary_files_requiring_visual_or_provenance_review": binaries,
        "git": history,
        "inventory": inventory,
        "limits": "Pattern and path checks cannot prove absence of secrets. Review binary assets and run a dedicated secret scanner too.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--report", type=Path)
    history_mode = parser.add_mutually_exclusive_group()
    history_mode.add_argument("--require-initial", action="store_true")
    history_mode.add_argument(
        "--expected-root",
        help="Require one reviewed root across all refs, allowing later public commits",
    )
    args = parser.parse_args()
    if args.expected_root and not re.fullmatch(r"[0-9a-fA-F]{40}", args.expected_root):
        parser.error(
            "--expected-root requires the full reviewed 40-character commit SHA"
        )
    root = args.root.resolve(strict=True)
    if args.report and args.report.resolve().is_relative_to(root):
        parser.error("Keep the audit receipt outside the publication tree")
    report = audit(root, args.require_initial, args.expected_root)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "inventory"},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
