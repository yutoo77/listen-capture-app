"""Fail closed for the optional EC2 instance-profile deployment mode.

This inspects configuration only; it never asks the SDK, IMDS, STS or AWS for
credentials. Local development stays unchanged unless explicitly selected.
"""


def validate_instance_role_environment(environment):
    forbidden = {
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_SECURITY_TOKEN",
        "AWS_CREDENTIAL_FILE",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "AWS_ROLE_SESSION_NAME",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
        "AWS_EC2_METADATA_SERVICE_ENDPOINT",
        "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
    }
    if any(environment.get(key) for key in forbidden):
        raise RuntimeError("Instance-role mode refuses alternate credential sources")
    if environment.get("AWS_EC2_METADATA_DISABLED", "").lower() != "false":
        raise RuntimeError(
            "Instance-role mode requires explicitly enabled EC2 metadata"
        )
    if environment.get("AWS_EC2_METADATA_V1_DISABLED", "").lower() != "true":
        raise RuntimeError("Instance-role mode requires IMDSv2 without v1 fallback")
    if any(
        environment.get(key) != "/dev/null"
        for key in ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "BOTO_CONFIG")
    ):
        raise RuntimeError(
            "Instance-role mode requires disabled credential/config files"
        )
