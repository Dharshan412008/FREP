# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS frontend-build

WORKDIR /web

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src
RUN npm run build


FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FREP_DB_PATH=/var/lib/frep/frep.db \
    FREP_PORT=8000

WORKDIR /app

# Keep every direct and transitive runtime dependency fixed, while still
# checking that the versions satisfy the project's declared requirements.
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --no-compile \
        "Flask==3.1.3" \
        "Werkzeug==3.1.8" \
        "Jinja2==3.1.6" \
        "itsdangerous==2.2.0" \
        "click==8.4.2" \
        "blinker==1.9.0" \
        "MarkupSafe==3.0.3" \
        "python-docx==1.2.0" \
        "lxml==6.1.1" \
        "typing_extensions==4.16.0" \
        "packaging==26.2" \
        "gunicorn==23.0.0" \
        --requirement requirements.txt \
    && python -m pip check

RUN groupadd --gid 10001 frep \
    && useradd --uid 10001 --gid 10001 --create-home \
        --home-dir /home/frep --shell /usr/sbin/nologin frep \
    && install -d --owner=frep --group=frep /var/lib/frep

# Copy only files served or imported at runtime. The checked-in database and
# development artifacts never enter the image.
COPY server.py ai_engine.py ./
COPY index.html styles.css app.js copilot-worker.js explanation.html ./
COPY manifest.json sw.js ./
COPY --from=frontend-build /web/dist ./frontend/dist

VOLUME ["/var/lib/frep"]
EXPOSE 8000

USER frep:frep

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2).read()"]

# One process prevents competing SQLite schema initialization. Threads retain
# concurrency for browser clients and long-lived server-sent event streams.
CMD ["gunicorn", "--bind=0.0.0.0:8000", "--workers=1", "--worker-class=gthread", "--threads=8", "--timeout=0", "--access-logfile=-", "--error-logfile=-", "server:app"]
