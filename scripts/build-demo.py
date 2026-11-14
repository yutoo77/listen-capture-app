"""Recreate the original, non-speech demo fixture using FFmpeg (no external audio).

Two minutes of quiet sine pulses, generated mathematically. No personal voice,
TTS model, third-party recording or network request is involved.
"""

import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ffmpeg = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg")
if not ffmpeg:
    raise SystemExit("Install FFmpeg or set FFMPEG_BINARY")
subprocess.run(
    [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.035*sin(2*PI*440*t)*lt(mod(t\\,2)\\,0.3):s=16000:d=120",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-map_metadata",
        "-1",
        str(ROOT / "backend/demo/sample.mp3"),
    ],
    check=True,
)
print("Created original 120-second tone fixture (not synthesized speech).")
