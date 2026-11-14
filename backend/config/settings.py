import os
from pathlib import Path
import tempfile
from urllib.parse import unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.environ.get("DJANGO_DEBUG", "0") == "1"
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError(
            "DJANGO_SECRET_KEY is required outside explicit development mode"
        )
    SECRET_KEY = "development-only-change-before-deployment-listen-capture"
ALLOWED_HOSTS = os.environ.get(
    "DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]"
).split(",")
CSRF_TRUSTED_ORIGINS = list(
    filter(None, os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(","))
)
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "rest_framework",
    "capture.apps.CaptureConfig",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "capture.middleware.RequestLogMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
db_url = os.environ.get("DATABASE_URL")
if db_url:
    parsed = urlparse(db_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("PostgreSQL is required; no SQLite fallback")
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": parsed.path.lstrip("/"),
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname,
            "PORT": parsed.port or 5432,
            "OPTIONS": {
                "sslmode": os.environ.get("POSTGRES_SSLMODE", "prefer"),
                "connect_timeout": 5,
            },
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("POSTGRES_DB", "listen_capture"),
            "USER": os.environ.get("POSTGRES_USER", "listen_capture"),
            "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
            "HOST": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
            "PORT": os.environ.get("POSTGRES_PORT", "54329"),
            "CONN_MAX_AGE": 60,
            "OPTIONS": {"connect_timeout": 5},
        }
    }
AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"
    },
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
LANGUAGE_CODE = "ja"
TIME_ZONE = "UTC"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# Never expose this directory using a public media route or a web-server static alias.
PRIVATE_MEDIA_ROOT = Path(
    os.environ.get("PRIVATE_MEDIA_ROOT", str(BASE_DIR / "private-media"))
)
PRIVATE_STORAGE_BACKEND = os.environ.get("PRIVATE_STORAGE_BACKEND", "local")
PRIVATE_STORAGE_MAX_OBJECT_BYTES = int(
    os.environ.get("PRIVATE_STORAGE_MAX_OBJECT_BYTES", str(128 * 1024 * 1024))
)
PRIVATE_S3_USE_APPROVED = os.environ.get("PRIVATE_S3_USE_APPROVED", "0") == "1"
PRIVATE_S3_BUCKET = os.environ.get("PRIVATE_S3_BUCKET", "")
PRIVATE_S3_PREFIX = os.environ.get("PRIVATE_S3_PREFIX", "listen-capture/private/v1/")
PRIVATE_S3_EXPECTED_OWNER = os.environ.get("PRIVATE_S3_EXPECTED_OWNER", "")
PRIVATE_S3_REGION = os.environ.get(
    "PRIVATE_S3_REGION", os.environ.get("AWS_REGION", "ap-northeast-1")
)
FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 13 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 12
FILE_UPLOAD_PERMISSIONS = 0o600
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 60 * 60 * 24 * 7
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_SSL_REDIRECT = not DEBUG and os.environ.get("DJANGO_SSL_REDIRECT", "1") == "1"
# Internal container readiness uses HTTP on the private API network. Only this
# response is exempt; it exposes a boolean DB check and no account information.
SECURE_REDIRECT_EXEMPT = [r"^api/health/$"]
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
CSRF_FAILURE_VIEW = "capture.auth.csrf_failure"
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication"
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"user": "600/hour", "memo_upload": "120/hour"},
    "EXCEPTION_HANDLER": "capture.errors.exception_handler",
}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
LOGIN_RATE_LIMIT = int(os.environ.get("LOGIN_RATE_LIMIT", "10"))
FFPROBE_BINARY = os.environ.get("FFPROBE_BINARY", "ffprobe")
FFMPEG_BINARY = os.environ.get("FFMPEG_BINARY", "ffmpeg")
NARRATION_ENCODING = os.environ.get("NARRATION_ENCODING", "mp3")
if NARRATION_ENCODING not in {"mp3", "wav"}:
    raise RuntimeError("NARRATION_ENCODING must be mp3 or wav")
POLLY_ENABLED = os.environ.get("POLLY_ENABLED", "0") == "1"
POLLY_BILLING_APPROVED = os.environ.get("POLLY_BILLING_APPROVED", "0") == "1"
LC_E2E_FIXTURE_TTS = os.environ.get("LC_E2E_FIXTURE_TTS", "0") == "1"
LC_E2E_LONG_AUDIO = os.environ.get("LC_E2E_LONG_AUDIO", "0") == "1"
LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT = int(
    os.environ.get("LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT", "480")
)
LC_TEST_ENVIRONMENT = os.environ.get("LC_TEST_ENVIRONMENT", "0") == "1"
LC_LOCAL_WINDOWS_TTS = os.environ.get("LC_LOCAL_WINDOWS_TTS", "0") == "1"
VOICEVOX_ENABLED = os.environ.get("VOICEVOX_ENABLED", "0") == "1"
VOICEVOX_BASE_URL = os.environ.get("VOICEVOX_BASE_URL", "http://127.0.0.1:50021")
VOICEVOX_SPEAKER_ID = int(os.environ.get("VOICEVOX_SPEAKER_ID", "14"))
AWS_METADATA_DISABLED = (
    os.environ.get("AWS_EC2_METADATA_DISABLED", "").lower() == "true"
)
if LC_E2E_FIXTURE_TTS and not (DEBUG and LC_TEST_ENVIRONMENT and AWS_METADATA_DISABLED):
    raise RuntimeError(
        "TTS fixtures require explicit test environment, DEBUG and disabled AWS metadata"
    )
if LC_E2E_LONG_AUDIO and not (
    LC_E2E_FIXTURE_TTS
    and DEBUG
    and LC_TEST_ENVIRONMENT
    and AWS_METADATA_DISABLED
    and 1 <= LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT <= 600
):
    raise RuntimeError(
        "Long audio fixtures require explicit guarded test mode and 1..600 seconds per segment"
    )
TTS_MAX_CHARACTERS = 3000
TTS_DAILY_USER_CHARACTERS = int(os.environ.get("TTS_DAILY_USER_CHARACTERS", "20000"))
TTS_DAILY_GLOBAL_CHARACTERS = int(
    os.environ.get("TTS_DAILY_GLOBAL_CHARACTERS", "100000")
)
TTS_DAILY_USER_REQUESTS = int(os.environ.get("TTS_DAILY_USER_REQUESTS", "20"))
TTS_USER_ACTIVE_JOBS = int(os.environ.get("TTS_USER_ACTIVE_JOBS", "3"))
TTS_GLOBAL_ACTIVE_JOBS = int(os.environ.get("TTS_GLOBAL_ACTIVE_JOBS", "100"))
TTS_JOB_LEASE_SECONDS = 120
AWS_REGION = os.environ.get("AWS_REGION", "ap-northeast-1")
LC_AWS_INSTANCE_ROLE_APPROVED = (
    os.environ.get("LC_AWS_INSTANCE_ROLE_APPROVED", "0") == "1"
)
if LC_AWS_INSTANCE_ROLE_APPROVED:
    from capture.aws_credentials import validate_instance_role_environment

    validate_instance_role_environment(os.environ)
TTS_CAPACITY_DISK_ROOT = Path(
    os.environ.get("TTS_CAPACITY_DISK_ROOT", tempfile.gettempdir())
)
TTS_CAPACITY_MIN_FREE_BYTES = int(
    os.environ.get("TTS_CAPACITY_MIN_FREE_BYTES", str(256 * 1024 * 1024))
)
MAX_DOCUMENTS_PER_USER = int(os.environ.get("MAX_DOCUMENTS_PER_USER", "200"))
MAX_MEMOS_PER_USER = int(os.environ.get("MAX_MEMOS_PER_USER", "500"))
MAX_PRIVATE_BYTES_PER_USER = int(
    os.environ.get("MAX_PRIVATE_BYTES_PER_USER", str(200 * 1024 * 1024))
)
MAX_VERSIONS_PER_DOCUMENT = int(os.environ.get("MAX_VERSIONS_PER_DOCUMENT", "100"))
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "capture.observability.JsonFormatter"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json"}},
    "loggers": {
        "capture": {"handlers": ["console"], "level": "INFO", "propagate": False}
    },
}
