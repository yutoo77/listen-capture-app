"""Private immutable objects. Callers authorize ownership before storage access.

Local remains default. Explicitly approved S3 objects are proxied through the app,
never exposed through public ACLs, URLs, browser credentials or custom endpoints.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import io
import logging
import os
from pathlib import Path
import re
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings

logger = logging.getLogger("capture.storage")


class StorageUnavailable(OSError):
    """Safe operational error without provider detail or object keys."""


class StorageMissing(FileNotFoundError):
    pass


@dataclass(frozen=True)
class StorageObject:
    key: str
    size_bytes: int
    modified_at: datetime
    etag: str | None = None


def validate_key(key):
    if (
        not isinstance(key, str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,254}", key)
        or any(part in {"", ".", ".."} for part in key.split("/"))
    ):
        raise ValueError("Invalid private storage key")
    return key


def validate_s3_configuration():
    if not settings.PRIVATE_S3_USE_APPROVED:
        raise StorageUnavailable("Private S3 use requires explicit approval")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", settings.PRIVATE_S3_BUCKET):
        raise StorageUnavailable("Private S3 bucket configuration is invalid")
    if not re.fullmatch(r"\d{12}", settings.PRIVATE_S3_EXPECTED_OWNER):
        raise StorageUnavailable("Private S3 requires the expected account owner")
    prefix = settings.PRIVATE_S3_PREFIX
    try:
        if not prefix.endswith("/") or len(prefix) > 200:
            raise ValueError()
        validate_key(prefix[:-1])
    except ValueError:
        raise StorageUnavailable("Private S3 prefix configuration is invalid") from None
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", settings.PRIVATE_S3_REGION):
        raise StorageUnavailable("Private S3 region configuration is invalid")


def _backend():
    backend = settings.PRIVATE_STORAGE_BACKEND
    if backend not in {"local", "s3"}:
        raise StorageUnavailable("Private storage backend is not configured")
    if backend == "s3":
        validate_s3_configuration()
    return backend


@lru_cache(maxsize=4)
def _client(region):
    # Unknown PUT outcomes may leave an orphan; they never publish a DB row.
    return boto3.client(
        "s3",
        region_name=region,
        use_ssl=True,
        verify=True,
        config=Config(
            ignore_configured_endpoint_urls=True,
            signature_version="s3v4",
            connect_timeout=5,
            read_timeout=20,
            retries={"mode": "standard", "total_max_attempts": 1},
        ),
    )


def _s3_call(operation, **arguments):
    try:
        return getattr(_client(settings.PRIVATE_S3_REGION), operation)(
            Bucket=settings.PRIVATE_S3_BUCKET,
            ExpectedBucketOwner=settings.PRIVATE_S3_EXPECTED_OWNER,
            **arguments,
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {
            "404",
            "NoSuchKey",
            "NotFound",
        }:
            raise StorageMissing("Private object is missing") from None
        raise StorageUnavailable("Private storage operation failed") from None
    except BotoCoreError:
        raise StorageUnavailable("Private storage operation failed") from None


def _object_key(key):
    return settings.PRIVATE_S3_PREFIX + validate_key(key)


def path_for(key):
    """Local compatibility only. Portable code uses open_read/read_bytes/stat."""
    if _backend() != "local":
        raise StorageUnavailable(
            "Filesystem paths are unavailable for private S3 objects"
        )
    key = validate_key(key)
    root = Path(settings.PRIVATE_MEDIA_ROOT).resolve()
    candidate = root / key
    current = candidate
    while current != root:
        if current.is_symlink():
            raise ValueError("Invalid private storage symlink")
        current = current.parent
    path = candidate.resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError("Invalid private storage key")
    return path


def put_bytes(data, suffix):
    if (
        not isinstance(data, bytes)
        or len(data) > settings.PRIVATE_STORAGE_MAX_OBJECT_BYTES
    ):
        raise StorageUnavailable("Private object exceeds its size limit")
    if not re.fullmatch(r"[a-z0-9]{1,8}", suffix):
        raise ValueError("Invalid private storage suffix")
    key = f"{uuid.uuid4().hex[:2]}/{uuid.uuid4().hex}.{suffix}"
    if _backend() == "s3":
        _s3_call(
            "put_object",
            Key=_object_key(key),
            Body=data,
            ContentLength=len(data),
            ContentType="application/octet-stream",
            ServerSideEncryption="AES256",
            IfNoneMatch="*",
            Metadata={"sha256": hashlib.sha256(data).hexdigest()},
        )
        return key
    path = path_for(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, "xb") as output:
            os.chmod(path, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return key


def stat(key):
    validate_key(key)
    if _backend() == "s3":
        value = _s3_call("head_object", Key=_object_key(key))
        return StorageObject(
            key, value["ContentLength"], value["LastModified"], value.get("ETag")
        )
    try:
        value = path_for(key).stat()
    except FileNotFoundError:
        raise StorageMissing("Private object is missing") from None
    return StorageObject(
        key, value.st_size, datetime.fromtimestamp(value.st_mtime, timezone.utc)
    )


class _BoundedReader:
    def __init__(self, source, length):
        self.source, self.remaining = source, length
        self.closed = False

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        amount = self.remaining if size < 0 else min(size, self.remaining)
        try:
            result = self.source.read(amount)
        except (OSError, BotoCoreError):
            raise StorageUnavailable("Private object stream failed") from None
        if not result and amount:
            raise StorageUnavailable("Private object stream ended early")
        self.remaining -= len(result)
        return result

    def close(self):
        if not self.closed:
            self.closed = True
            self.source.close()

    def __enter__(self):
        return self

    def __exit__(self, *arguments):
        self.close()


def open_read(key, *, start=0, length=None, etag=None):
    """Open a closeable bounded range; remote ranges replace filesystem seek."""
    validate_key(key)
    backend = _backend()
    if start < 0 or (length is not None and length < 0):
        raise ValueError("Invalid private object range")
    if length == 0:
        return _BoundedReader(io.BytesIO(), 0)
    if backend == "s3":
        arguments = {"Key": _object_key(key)}
        if start or length is not None:
            arguments["Range"] = (
                f"bytes={start}-{start + length - 1 if length is not None else ''}"
            )
        if etag:
            arguments["IfMatch"] = etag
        response = _s3_call("get_object", **arguments)
        source, size = response["Body"], response["ContentLength"]
        if size > settings.PRIVATE_STORAGE_MAX_OBJECT_BYTES or (
            length is not None and size != length
        ):
            source.close()
            raise StorageUnavailable("Private object size changed or exceeds its limit")
        return _BoundedReader(source, size)
    try:
        source = path_for(key).open("rb")
    except FileNotFoundError:
        raise StorageMissing("Private object is missing") from None
    size = os.fstat(source.fileno()).st_size
    requested = size - start if length is None else length
    if (
        requested < 0
        or start + requested > size
        or requested > settings.PRIVATE_STORAGE_MAX_OBJECT_BYTES
    ):
        source.close()
        raise StorageUnavailable("Private object size changed or exceeds its limit")
    source.seek(start)
    return _BoundedReader(source, requested)


def read_bytes(key, *, max_bytes):
    if max_bytes < 0 or max_bytes > settings.PRIVATE_STORAGE_MAX_OBJECT_BYTES:
        raise ValueError("Invalid private read limit")
    item = stat(key)
    if item.size_bytes > max_bytes:
        raise StorageUnavailable("Private object exceeds the processing limit")
    with open_read(key, length=item.size_bytes, etag=item.etag) as source:
        data = b"".join(iter(lambda: source.read(65536), b""))
        if len(data) != item.size_bytes:
            raise StorageUnavailable("Private object size changed")
        return data


def delete_key(key):
    try:
        if _backend() == "s3":
            _s3_call("delete_object", Key=_object_key(key))
        else:
            path_for(key).unlink(missing_ok=True)
        return True
    except OSError:
        logger.error("private_file_delete_failed")
        return False


def objects():
    if _backend() == "local":
        for path in files():
            yield stat(path.relative_to(Path(settings.PRIVATE_MEDIA_ROOT)).as_posix())
        return
    token = None
    while True:
        arguments = {"Prefix": settings.PRIVATE_S3_PREFIX, "MaxKeys": 1000}
        if token:
            arguments["ContinuationToken"] = token
        response = _s3_call("list_objects_v2", **arguments)
        for item in response.get("Contents", []):
            if not item["Key"].startswith(settings.PRIVATE_S3_PREFIX):
                logger.warning("private_storage_unrecognized_key")
                continue
            key = item["Key"][len(settings.PRIVATE_S3_PREFIX) :]
            if not key:
                continue
            try:
                validate_key(key)
            except ValueError:
                logger.warning("private_storage_unrecognized_key")
                continue
            yield StorageObject(
                key, item["Size"], item["LastModified"], item.get("ETag")
            )
        if not response.get("IsTruncated"):
            return
        next_token = response.get("NextContinuationToken")
        if not next_token or next_token == token:
            raise StorageUnavailable("Private object listing did not advance")
        token = next_token


def files():
    """Local compatibility. Portable maintenance uses objects()."""
    if _backend() != "local":
        raise StorageUnavailable(
            "Filesystem listing is unavailable for private S3 objects"
        )
    root = Path(settings.PRIVATE_MEDIA_ROOT)
    if root.exists():
        yield from (
            item for item in root.rglob("*") if item.is_file() and not item.is_symlink()
        )
