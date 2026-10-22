# Kairo (回路)

Kairo is a remote Docker sandbox platform for executing untrusted code securely with real-time streamed output over WebSockets and horizontal Redis-backed queue scaling.

## Architecture Overview

```text
┌──────────┐   HTTPS/WS   ┌──────────────┐    XADD     ┌───────────────┐
│ Browser  │─────────────▶│  Kairo API   │────────────▶│ Redis Stream  │
│ (React)  │◀─────────────│  (Go, chi)   │             │  kairo:jobs   │
└──────────┘  live logs   └──────┬───────┘             └───────┬───────┘
                                 │ subscribe                   │ XREADGROUP
                                 ▼                             ▼
                          ┌──────────────┐             ┌───────────────┐
                          │ Redis PubSub │◀────────────│ Kairo Worker  │
                          │  + job logs  │   publish   │     (Go)      │
                          └──────────────┘             └───────┬───────┘
                                                               │ Docker API
                                                               ▼
                                                       ┌───────────────┐
                                                       │    Sandbox    │
                                                       │   container   │
                                                       └───────────────┘
```

## Features

- **Isolated Execution**: Every run executes in an ephemeral, resource-limited container (`CapDrop: ALL`, `ReadonlyRootfs`, `NetworkMode: none`, custom seccomp profile, gVisor `runsc` compatible).
- **Live Streaming**: Real-time stdout/stderr multiplexing streamed over WebSockets and backed by Redis Streams for replay.
- **Strict Limit Enforcement**: Hard CPU, Memory, PID, time, and output size caps.
- **Scalable Architecture**: Decoupled API and Worker services coordinated via Redis consumer groups.

## Quickstart

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) & Docker Compose
- [Go 1.22+](https://golang.org/dl/) (for local development)
- [golangci-lint](https://golangci-lint.run/)

### Running the Stack with Docker Compose

```bash
# Start Redis, Postgres, Kairo API, and Kairo Worker
make up

# Check status of containers
make ps

# View service logs
make logs

# Stop stack
make down
```

### Health & Readiness Checks

- **Liveness probe**: `GET http://localhost:8080/healthz`
- **Readiness probe**: `GET http://localhost:8080/readyz` (verifies Redis and PostgreSQL reachability)

## Development & Testing

```bash
# Run unit tests
make test

# Run linter
make lint

# Build local binaries
make build
```

## Security

Please refer to [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for details on sandbox hardening, fork-bomb containment, memory limits, and container isolation.
