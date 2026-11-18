//go:build integration

package sandbox_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/sandbox"
)

// Security Regression Test Suite ensures all container escapes, permission escalations,
// dangerous syscalls, and resource exhaustion attempts fail safely and predictably.
func TestSecurityRegression_AllAttacksFailSafely(t *testing.T) {
	reg := languages.NewRegistry()
	py, err := reg.Get("python")
	if err != nil {
		t.Fatalf("python language config missing: %v", err)
	}

	cLang, err := reg.Get("c")
	if err != nil {
		t.Fatalf("c language config missing: %v", err)
	}

	bash, err := reg.Get("bash")
	if err != nil {
		t.Fatalf("bash language config missing: %v", err)
	}

	tests := []struct {
		name       string
		lang       languages.LanguageConfig
		source     string
		expectFail func(res *sandbox.ExecutionResult) error
	}{
		{
			name: "BlockedSyscall_Ptrace",
			lang: cLang,
			source: `
#include <stdio.h>
#include <sys/ptrace.h>
#include <errno.h>

int main() {
    long ret = ptrace(PTRACE_TRACEME, 0, NULL, NULL);
    if (ret == -1) {
        printf("ptrace blocked: errno %d\n", errno);
        return 0; // successfully trapped by seccomp/capability
    }
    printf("FATAL: ptrace allowed\n");
    return 1;
}
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.ExitCode != 0 || strings.Contains(res.Stdout, "FATAL") {
					return fmt.Errorf("ptrace was unexpectedly allowed: stdout=%s stderr=%s", res.Stdout, res.Stderr)
				}
				return nil
			},
		},
		{
			name: "BlockedSyscall_Mount",
			lang: cLang,
			source: `
#include <stdio.h>
#include <sys/mount.h>
#include <errno.h>

int main() {
    int ret = mount("none", "/tmp", "tmpfs", 0, "");
    if (ret == -1) {
        printf("mount blocked: errno %d\n", errno);
        return 0; // safely blocked
    }
    printf("FATAL: mount allowed\n");
    return 1;
}
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.ExitCode != 0 || strings.Contains(res.Stdout, "FATAL") {
					return fmt.Errorf("mount was unexpectedly allowed: stdout=%s stderr=%s", res.Stdout, res.Stderr)
				}
				return nil
			},
		},
		{
			name: "Filesystem_ReadonlyRootfs",
			lang: bash,
			source: `
if touch /root_test 2>/dev/null; then
    echo "FATAL: wrote to rootfs"
    exit 1
fi
echo "rootfs write blocked safely"
exit 0
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.ExitCode != 0 || strings.Contains(res.Stdout, "FATAL") {
					return fmt.Errorf("rootfs was writable: %s", res.Stdout)
				}
				return nil
			},
		},
		{
			name: "Network_ZeroOutboundSockets",
			lang: py,
			source: `
import socket, sys
try:
    s = socket.create_connection(("1.1.1.1", 53), timeout=1)
    print("FATAL: outbound socket connected")
    sys.exit(1)
except Exception as e:
    print(f"network blocked safely: {type(e).__name__}")
    sys.exit(0)
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.ExitCode != 0 || strings.Contains(res.Stdout, "FATAL") {
					return fmt.Errorf("network connection succeeded: stdout=%s", res.Stdout)
				}
				return nil
			},
		},
		{
			name: "ForkBomb_PidsLimit",
			lang: py,
			source: `
import os
try:
    while True:
        os.fork()
except (BlockingIOError, OSError):
    print("fork bomb trapped safely by pids limit")
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.Status != sandbox.StatusCompleted && res.Status != sandbox.StatusFailed && res.Status != sandbox.StatusTimeout {
					return fmt.Errorf("unexpected fork bomb status: %s", res.Status)
				}
				return nil
			},
		},
		{
			name: "NonRoot_NoPrivilegeEscalation",
			lang: bash,
			source: `
uid=$(id -u)
if [ "$uid" -eq 0 ]; then
    echo "FATAL: running as root"
    exit 1
fi
echo "running safely as non-root uid $uid"
exit 0
`,
			expectFail: func(res *sandbox.ExecutionResult) error {
				if res.ExitCode != 0 || strings.Contains(res.Stdout, "FATAL") {
					return fmt.Errorf("container ran as root: %s", res.Stdout)
				}
				return nil
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cli := newTestDockerClient(t)
			defer func() { _ = cli.Close() }()

			s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")
			res, err := s.Run(context.Background(), sandbox.ExecutionSpec{
				JobID:      fmt.Sprintf("sec-reg-%d", time.Now().UnixNano()),
				Language:   tc.lang,
				SourceCode: tc.source,
				Limits:     tc.lang.DefaultLimits,
			})
			if err != nil {
				t.Fatalf("runtime failure: %v", err)
			}
			if err := tc.expectFail(res); err != nil {
				t.Fatalf("security violation: %v", err)
			}
			assertNoOrphanContainers(t, cli)
		})
	}
}
