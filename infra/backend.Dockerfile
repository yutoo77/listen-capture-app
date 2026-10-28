FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app
WORKDIR /app
COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock
COPY --chown=app:app backend/ ./
COPY --chown=app:app scripts/database_roles.py ./operations/database_roles.py
COPY --chown=app:app scripts/database_role_config.py ./operations/database_role_config.py
RUN mkdir -p /app/private-media /app/private-tmp \
    && chown app:app /app/private-media /app/private-tmp \
    && chmod 700 /app/private-tmp
USER app
EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 2 --timeout 60 --access-logfile - --error-logfile -"]
