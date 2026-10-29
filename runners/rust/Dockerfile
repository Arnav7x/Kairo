FROM rust:alpine

# Security: non-root user and group (UID 10001 per Section 6)
RUN apk add --no-cache musl-dev gcc && \
    addgroup -g 10001 sandbox && \
    adduser -u 10001 -G sandbox -s /bin/sh -D sandbox && \
    mkdir -p /workspace /tmp /tmp/cargo /tmp/rustup && \
    chown -R sandbox:sandbox /workspace /tmp && \
    chmod 700 /workspace /tmp

USER 10001:10001
WORKDIR /workspace

ENV CARGO_HOME=/tmp/cargo \
    RUSTUP_HOME=/tmp/rustup

CMD ["./main"]

