FROM alpine:3.20

# Security: non-root user and group (UID 10001 per Section 6)
RUN apk add --no-cache bash coreutils && \
    addgroup -g 10001 sandbox && \
    adduser -u 10001 -G sandbox -s /bin/bash -D sandbox && \
    mkdir -p /workspace /tmp && \
    chown -R sandbox:sandbox /workspace /tmp && \
    chmod 700 /workspace /tmp

USER 10001:10001
WORKDIR /workspace

CMD ["bash", "main.sh"]

