import hashlib
import json

from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .tts_config import configuration


def session_payload(request):
    user = request.user
    tts = configuration()
    return {
        "user": {"id": str(user.pk), "username": user.get_username()}
        if user.is_authenticated
        else None,
        "csrfToken": get_token(request),
        "ttsAvailable": tts["enabled"],
        "tts": tts,
    }


@require_GET
@ensure_csrf_cookie
def session(request):
    response = JsonResponse(session_payload(request))
    response["Cache-Control"] = "no-store"
    return response


def csrf_failure(request, reason=""):
    return JsonResponse(
        {
            "detail": "セッションの確認に失敗しました。画面を再読み込みして再試行してください。"
        },
        status=403,
    )


@require_POST
@csrf_protect
def login_view(request):
    if request.content_type != "application/json":
        return JsonResponse({"detail": "JSONで送信してください。"}, status=400)
    try:
        body = json.loads(request.body)
        username, password = body["username"], body["password"]
        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or not 1 <= len(username) <= 150
            or not 1 <= len(password) <= 1024
        ):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        return JsonResponse(
            {"detail": "ユーザー名とパスワードを確認してください。"}, status=400
        )
    # Remote address is supplied by the trusted reverse proxy, never an arbitrary XFF.
    address = request.META.get("REMOTE_ADDR", "unknown")
    key = (
        "login:"
        + hashlib.sha256(f"{address}:{username.casefold()}".encode()).hexdigest()
    )
    cache.add(key, 0, 600)
    attempts = cache.incr(key)
    if attempts > settings.LOGIN_RATE_LIMIT:
        response = JsonResponse(
            {"detail": "試行回数が多いため、10分後に再試行してください。"}, status=429
        )
        response["Retry-After"] = "600"
        return response
    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse(
            {"detail": "ユーザー名またはパスワードが正しくありません。"}, status=400
        )
    cache.delete(key)
    login(request, user)
    response = JsonResponse(session_payload(request))
    response["Cache-Control"] = "no-store"
    return response


@require_POST
@csrf_protect
def logout_view(request):
    logout(request)
    return HttpResponse(status=204)
