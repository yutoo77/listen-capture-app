from django.core.exceptions import RequestDataTooBig
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


def exception_handler(exc, context):
    if isinstance(exc, RequestDataTooBig):
        return Response(
            {"detail": "アップロードの容量上限を超えています。"}, status=413
        )
    return drf_exception_handler(exc, context)
