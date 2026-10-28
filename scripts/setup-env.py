"""Create ignored, local-only credentials; never print them or replace an existing file."""

from pathlib import Path
import secrets

root = Path(__file__).resolve().parents[1]
example = (root / ".env.example").read_text(encoding="utf-8")
content = example.replace(
    "DJANGO_SECRET_KEY=generate-with-setup-env",
    f"DJANGO_SECRET_KEY={secrets.token_urlsafe(64)}",
)
content = content.replace(
    "POSTGRES_PASSWORD=generate-with-setup-env",
    f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}",
)
with (root / ".env").open("x", encoding="utf-8", newline="\n") as target:
    target.write(content)
print("Created .env with local secrets. Keep this file private.")
