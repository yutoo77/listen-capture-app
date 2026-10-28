"""Native development helper. Compose injects environment directly instead."""

import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def load_env():
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip() and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key, value)
    probes = list((ROOT / ".runtime" / "ffmpeg").glob("*/bin/ffprobe.exe"))
    if probes:
        os.environ.setdefault("FFPROBE_BINARY", str(probes[0]))
        os.environ.setdefault("FFMPEG_BINARY", str(probes[0].with_name("ffmpeg.exe")))


if __name__ == "__main__":
    load_env()
    raise SystemExit(
        subprocess.call(
            [sys.executable, "manage.py", *sys.argv[1:]], cwd=ROOT / "backend"
        )
    )
