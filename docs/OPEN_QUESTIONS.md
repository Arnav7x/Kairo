# Open Questions & Architecture Notes

This document tracks unresolved questions, platform quirks, or security tradeoffs in accordance with rule 9 of the implementation plan.

---

### Phase 0 / Local Environment Setup

1. **Host Docker & Go Runtime on macOS:**
   - Go 1.22+ and Docker daemon are not currently installed on the host macOS machine.
   - For complete end-to-end local execution of `make up` directly on the host, Docker Desktop (or OrbStack / Colima) and Go need to be installed.
   - CI (`.github/workflows/ci.yml`) runs on GitHub Actions Linux runners with Go 1.22, Docker, and golangci-lint pre-installed.
