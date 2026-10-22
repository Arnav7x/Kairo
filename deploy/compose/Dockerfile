# Build stage for Go binaries
FROM golang:1.22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum* ./
RUN go mod download || true

COPY . .

# Build static binaries
ARG TARGET_CMD=api
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /bin/service ./cmd/${TARGET_CMD}

# Minimal runtime image
FROM alpine:3.19

RUN addgroup -g 10001 kairo && \
    adduser -u 10001 -G kairo -s /bin/sh -D kairo

USER 10001:10001

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /bin/service /usr/local/bin/service

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/service"]
