FROM eclipse-temurin:21-alpine

# Security: non-root user and group (UID 10001 per Section 6)
RUN addgroup -g 10001 sandbox && \
    adduser -u 10001 -G sandbox -s /bin/sh -D sandbox && \
    mkdir -p /workspace /tmp && \
    chown -R sandbox:sandbox /workspace /tmp && \
    chmod 700 /workspace /tmp

USER 10001:10001
WORKDIR /workspace

ENV JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=/tmp"

CMD ["java", "Main"]

