"""Untrusted PDF work runs outside the HTTP/worker process with OS limits."""

import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import tempfile

MAX_BYTES = 10 * 1024 * 1024
MAX_PAGES = 200
MAX_SELECTED_PAGES = 50
MAX_TEXT = 20000
MAX_SECONDS = 20
MAX_MEMORY = 512 * 1024 * 1024
MAX_RESULT = 256 * 1024


class PdfFailure(Exception):
    def __init__(self, code, *, page_count=None):
        self.code = code
        self.page_count = page_count
        super().__init__(code)


def _windows_job(process):
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_longlong),
            ("job_time", ctypes.c_longlong),
            ("flags", wintypes.DWORD),
            ("minimum_working_set", ctypes.c_size_t),
            ("maximum_working_set", ctypes.c_size_t),
            ("active_processes", wintypes.DWORD),
            ("affinity", ctypes.c_size_t),
            ("priority", wintypes.DWORD),
            ("scheduling", wintypes.DWORD),
        ]

    class IO(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_ulonglong)
            for name in (
                "read_operations",
                "write_operations",
                "other_operations",
                "read_bytes",
                "write_bytes",
                "other_bytes",
            )
        ]

    class Extended(ctypes.Structure):
        _fields_ = [
            ("basic", Basic),
            ("io", IO),
            ("process_memory", ctypes.c_size_t),
            ("job_memory", ctypes.c_size_t),
            ("peak_process", ctypes.c_size_t),
            ("peak_job", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise PdfFailure("sandbox_unavailable")
    limits = Extended()
    limits.basic.flags = (
        0x100 | 0x2000 | 0x8
    )  # process memory, kill-on-close, one process
    limits.basic.active_processes = 1
    limits.process_memory = MAX_MEMORY
    if not kernel.SetInformationJobObject(
        handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
    ) or not kernel.AssignProcessToJobObject(
        handle, wintypes.HANDLE(int(process._handle))
    ):
        kernel.CloseHandle(handle)
        raise PdfFailure("sandbox_unavailable")
    return lambda: kernel.CloseHandle(handle)


def extract(data, *, start_page=None, end_page=None):
    if not data.startswith(b"%PDF-") or not 0 < len(data) <= MAX_BYTES:
        raise PdfFailure("invalid_pdf")
    if (start_page is not None or end_page is not None) and (
        type(start_page) is not int
        or type(end_page) is not int
        or not 1 <= start_page <= end_page <= MAX_PAGES
        or end_page - start_page + 1 > MAX_SELECTED_PAGES
    ):
        raise PdfFailure("invalid_page_range")
    with tempfile.TemporaryDirectory(prefix="lc-pdf-") as directory:
        source, result = Path(directory) / "source.pdf", Path(directory) / "result.json"
        source.write_bytes(data)
        os.chmod(source, 0o600)
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper()
            in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "LC_ALL"}
        }
        command = [
            # A Windows venv's python.exe is a launcher that spawns the real
            # interpreter. Launch the interpreter directly so process-count=1
            # still forbids all child processes while parsing untrusted data.
            getattr(sys, "_base_executable", sys.executable)
            if os.name == "nt"
            else sys.executable,
            "-I",
            str(Path(__file__).with_name("pdf_parser.py")),
            str(source),
            str(result),
            sysconfig.get_paths()["purelib"],
            str(start_page) if start_page is not None else "-",
            str(end_page) if end_page is not None else "-",
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

        def close_job():
            return None

        try:
            if os.name == "nt":
                close_job = _windows_job(process)
            elif os.name != "posix":
                raise PdfFailure("sandbox_unavailable")
            # The child does not import the parser or read PDF bytes until limits
            # are installed. No app/AWS/DB secrets are passed in its environment.
            process.communicate(input=b"1", timeout=MAX_SECONDS)
            if process.returncode or not result.is_file():
                raise PdfFailure(
                    "resource_limit" if process.returncode else "invalid_pdf"
                )
            if result.stat().st_size > MAX_RESULT:
                raise PdfFailure("resource_limit")
            parsed = json.loads(result.read_text(encoding="utf-8"))
            if parsed.get("error_code"):
                code = parsed["error_code"]
                if code not in {
                    "encrypted_pdf",
                    "page_limit",
                    "active_content",
                    "resource_limit",
                    "text_limit",
                    "invalid_pdf",
                    "no_text",
                    "page_selection_required",
                    "invalid_page_range",
                }:
                    code = "invalid_pdf"
                pages = parsed.get("page_count")
                raise PdfFailure(
                    code,
                    page_count=pages
                    if type(pages) is int and 1 <= pages <= MAX_PAGES
                    else None,
                )
            text, pages = parsed.get("text"), parsed.get("page_count")
            first, last = parsed.get("start_page"), parsed.get("end_page")
            if (
                not isinstance(text, str)
                or not text.strip()
                or "\x00" in text
                or len(text) > MAX_TEXT
                or not isinstance(pages, int)
                or not 1 <= pages <= MAX_PAGES
                or type(first) is not int
                or type(last) is not int
                or not 1 <= first <= last <= pages
                or last - first + 1 > MAX_SELECTED_PAGES
                or (start_page is not None and (first, last) != (start_page, end_page))
            ):
                raise PdfFailure("invalid_pdf")
            return {
                "text": text,
                "page_count": pages,
                "start_page": first,
                "end_page": last,
            }
        except subprocess.TimeoutExpired as error:
            raise PdfFailure("processing_timeout") from error
        except (OSError, ValueError, KeyError) as error:
            raise PdfFailure("invalid_pdf") from error
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            close_job()
