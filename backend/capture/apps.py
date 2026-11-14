from django.apps import AppConfig


class CaptureConfig(AppConfig):
    name = "capture"

    def ready(self):
        from . import signals  # noqa: F401
