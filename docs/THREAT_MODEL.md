# Threat Model & Sandbox Security (Kairo)

## 1. Security Philosophy
**Assume every user submission is hostile.** Apply defense-in-depth at container, runtime, host, and network layers. No single defense mechanism is trusted exclusively.

---

## 2. Threat Vectors & Mitigations

### 2.1 Escape Attempts (Kernel & Container Breakouts)
- **Mitigation:**
  - Mandatory non-root user (`UID 10001:GID 10001`).
  - Strict capability dropping: `CapDrop: ["ALL"]`.
  - Prevent privilege escalation: `no-new-privileges: true`.
  - Custom seccomp filter (`deploy/compose/seccomp.json`) blocking dangerous syscalls (`ptrace`, `mount`, `bpf`, `userfaultfd`, `kexec_*`, `unshare`, `keyctl`).
  - Optional hardened isolation via **gVisor (`runsc`)** sandbox kernel (`KAIRO_RUNTIME=runsc`).
  - No Docker socket mounted inside sandboxes. No host directory mounts.

### 2.2 Fork Bombs & Process Exhaustion
- **Mitigation:**
  - Strict PID limit: `PidsLimit = 64`.
  - Ulimits enforced: `nproc = 64`, `nofile = 256`.
  - Any attempt to spawn recursive processes hits the PID ceiling immediately without starving host threads.

### 2.3 Memory Bombs (OOM Exhaustion)
- **Mitigation:**
  - Hard memory cap: `default 256 MB`, server ceiling `1024 MB`.
  - Swap disabled: `MemorySwap = Memory` (prevents swap thrashing on the host).
  - Worker inspects container state upon termination (`State.OOMKilled`) and maps the job status to `oom_killed`.

### 2.4 CPU Abuse & Crypto-Mining
- **Mitigation:**
  - CPU quota enforced: `NanoCPUs = 500,000,000` (0.5 CPU, max 2.0).
  - Hard wall-clock timeout enforced strictly by the worker outside the container (using Go `context.WithTimeout` followed by `ContainerKill`), not by code inside the container.
  - Abusive patterns flagged via source hashes and metrics.

### 2.5 Disk Fill & Inode Exhaustion
- **Mitigation:**
  - Read-only root filesystem: `ReadonlyRootfs: true`.
  - Size-capped `tmpfs` mounts only at `/workspace` (e.g. 64 MB) and `/tmp`.
  - Input submission payload limit: `KAIRO_MAX_SOURCE_BYTES = 256 KB`.
  - Core dumps disabled: `core = 0`.

### 2.6 Output Flooding (Log Bombing)
- **Mitigation:**
  - Hard output cap per job: `KAIRO_MAX_OUTPUT_BYTES = 1048576` (1 MB).
  - Worker streams chunks through an output counter; if exceeded, container is killed immediately with status `output_limit`.

### 2.7 Network Abuse (SSRF, Port Scanning, C2, Botnets)
- **Mitigation:**
  - Network disabled by default: `NetworkMode: "none"`.
  - Containers cannot establish outbound sockets, reach cloud metadata endpoints (e.g., `169.254.169.254`), or talk to internal cluster services (Postgres, Redis, API).

### 2.8 Noisy Neighbors & Queue Flooding
- **Mitigation:**
  - Rate limiting (token bucket in Redis) per IP / API key.
  - Queue depth backpressure (returns `429` or `503` with `Retry-After`).
  - Per-user concurrency limits to ensure fair worker scheduling.

### 2.9 Orphaned Containers
- **Mitigation:**
  - Containers created with metadata labels: `kairo.job_id`, `kairo.created_at`.
  - Container removal deferred (`defer docker.ContainerRemove(...)`) on all code paths.
  - Periodic container reaper routine cleans up any labeled containers older than `KAIRO_REAPER_MAX_AGE` (covers worker crashes/hard reboots).
