import logging
import time
import uuid

logger = logging.getLogger("capture.requests")


class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.monotonic()
        request_id = uuid.uuid4().hex
        response = self.get_response(request)
        response["X-Request-ID"] = request_id
        if request.path.startswith("/api/"):
            response["Cache-Control"] = "private, no-store"
        # No body, password, cookie, transcript, file name or query string in logs.
        logger.info(
            "http_request",
            extra={
                "event": "http_request",
                "request_id": request_id,
                "method": request.method,
                "scope": "health"
                if request.path == "/api/health/"
                else "api"
                if request.path.startswith("/api/")
                else "web",
                "status": response.status_code,
                "elapsed_ms": round(max(0, time.monotonic() - start) * 1000, 3),
            },
        )
        return response
