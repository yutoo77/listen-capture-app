from django.conf import settings


def provider_enabled(provider):
    if provider == "fixture":
        return bool(
            settings.LC_E2E_FIXTURE_TTS
            and settings.DEBUG
            and settings.LC_TEST_ENVIRONMENT
            and settings.AWS_METADATA_DISABLED
        )
    return bool(settings.POLLY_ENABLED and settings.POLLY_BILLING_APPROVED)


def configuration():
    provider = "fixture" if provider_enabled("fixture") else "polly"
    return {
        "enabled": provider_enabled(provider),
        "provider": provider,
        "max_characters": settings.TTS_MAX_CHARACTERS,
        "daily_character_limit": settings.TTS_DAILY_USER_CHARACTERS,
        "voice": "silent-test-fixture" if provider == "fixture" else "Mizuki",
        "engine": "fixture" if provider == "fixture" else "standard",
        "price_per_million_usd": 0 if provider == "fixture" else 4,
    }
