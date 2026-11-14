"""Fixed isolated child. Never imports Django, credentials, storage or HTTP code."""

import json
import os
from pathlib import Path
import sys


class Rejected(Exception):
    pass


def main():
    if sys.stdin.buffer.read(1) != b"1":
        return
    if os.name == "posix":
        import resource

        for kind, limit in (
            (resource.RLIMIT_AS, 512 * 1024 * 1024),
            (resource.RLIMIT_CPU, 10),
            (resource.RLIMIT_FSIZE, 256 * 1024),
            (resource.RLIMIT_CORE, 0),
            (resource.RLIMIT_NOFILE, 32),
            (resource.RLIMIT_NPROC, 0),
        ):
            _, hard = resource.getrlimit(kind)
            bound = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(kind, (bound, bound))
    result = {}
    pages = None
    try:
        # Fixed dependency directory supplied by our parent, never by PDF data
        # or environment variables. Required for Windows venv launch isolation.
        sys.path.insert(0, sys.argv[3])
        from pypdf import PdfReader
        from pypdf.generic import IndirectObject

        reader = PdfReader(sys.argv[1], strict=True)
        if reader.is_encrypted:
            raise Rejected("encrypted_pdf")
        pages = len(reader.pages)
        if not 1 <= pages <= 200:
            raise Rejected("page_limit")
        pending, visited, count = [reader.trailer["/Root"]], set(), 0
        forbidden = {
            "/JS",
            "/JavaScript",
            "/EmbeddedFiles",
            "/OpenAction",
            "/AA",
            "/AcroForm",
            "/XFA",
            "/RichMediaContent",
        }
        while pending:
            item = pending.pop()
            if isinstance(item, IndirectObject):
                identity = (item.idnum, item.generation)
                if identity in visited:
                    continue
                visited.add(identity)
                item = item.get_object()
            count += 1
            if count > 100000:
                raise Rejected("resource_limit")
            if isinstance(item, dict):
                if (
                    forbidden.intersection(item)
                    or item.get("/S")
                    in {
                        "/JavaScript",
                        "/Launch",
                        "/SubmitForm",
                        "/ImportData",
                        "/GoToR",
                        "/Rendition",
                    }
                    or item.get("/Type") == "/EmbeddedFile"
                ):
                    raise Rejected("active_content")
                pending.extend(item.values())
            elif isinstance(item, (list, tuple)):
                pending.extend(item)
        start_page = int(sys.argv[4]) if sys.argv[4] != "-" else None
        end_page = int(sys.argv[5]) if sys.argv[5] != "-" else None
        if start_page is None and end_page is None:
            if pages > 50:
                raise Rejected("page_selection_required")
            start_page, end_page = 1, pages
        if (
            start_page is None
            or end_page is None
            or not 1 <= start_page <= end_page <= pages
            or end_page - start_page + 1 > 50
        ):
            raise Rejected("invalid_page_range")
        parts = []
        size = 0
        for index in range(start_page - 1, end_page):
            page = reader.pages[index]
            content = page.get_contents()
            if content is not None and len(content.get_data()) > 4 * 1024 * 1024:
                raise Rejected("resource_limit")
            text = page.extract_text() or ""
            size += len(text) + (2 if parts else 0)
            if size > 20000:
                raise Rejected("text_limit")
            if "\x00" in text:
                raise Rejected("invalid_pdf")
            parts.append(text)
        text = "\n\n".join(parts)
        if not text.strip():
            raise Rejected("no_text")
        result = {
            "text": text,
            "page_count": pages,
            "start_page": start_page,
            "end_page": end_page,
        }
    except Rejected as error:
        result = {"error_code": str(error)}
        if isinstance(pages, int) and 1 <= pages <= 200:
            result["page_count"] = pages
    except MemoryError:
        result = {"error_code": "resource_limit"}
    except Exception:
        result = {"error_code": "invalid_pdf"}
    Path(sys.argv[2]).write_text(
        json.dumps(result, ensure_ascii=True), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
