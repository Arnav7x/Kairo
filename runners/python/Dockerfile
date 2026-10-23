FROM python:3.12-alpine@sha256:b658b05ce9c4eb97ec6fc19424818a1f31993659c2b505a532f470e83807815d

# Security: non-root user and group (UID 10001 per Section 6)
RUN addgroup -g 10001 sandbox && \
    adduser -u 10001 -G sandbox -s /bin/sh -D sandbox && \
    mkdir -p /workspace /tmp && \
    chown -R sandbox:sandbox /workspace /tmp && \
    chmod 700 /workspace /tmp

USER 10001:10001
WORKDIR /workspace

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

CMD ["python3", "main.py"]
