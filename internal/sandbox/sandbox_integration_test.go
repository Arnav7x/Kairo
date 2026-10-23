//go:build integration

package sandbox_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

func newTestDockerClient(t *testing.T) *client.Client {
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	if os.Getenv("DOCKER_HOST") == "" {
		if _, err := os.Stat("/var/run/docker.sock"); err != nil {
			userSock := os.ExpandEnv("$HOME/.docker/run/docker.sock")
			if _, sErr := os.Stat(userSock); sErr == nil {
				opts = append(opts, client.WithHost("unix://"+userSock))
			}
		}
	}

	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		t.Fatalf("failed to connect to Docker: %v", err)
	}
	return cli
}

// Acceptance 1: print('hello') returns stdout hello, exit 0
func TestAcceptance_HelloWorld(t *testing.T) {
	cli := newTestDockerClient(t)
	defer func() { _ = cli.Close() }()

	reg := languages.NewRegistry()
	py, err := reg.Get("python")
	if err != nil {
		t.Fatalf("failed to get python config: %v", err)
	}

	s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")
	res, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:      fmt.Sprintf("test-hello-%d", time.Now().UnixNano()),
		Language:   py,
		SourceCode: "print('hello')",
		Limits:     py.DefaultLimits,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Status != sandbox.StatusCompleted {
		t.Errorf("expected status completed, got %s (err: %s)", res.Status, res.ErrorMessage)
	}
	if res.ExitCode != 0 {
		t.Errorf("expected exit 0, got %d", res.ExitCode)
	}
	if !strings.Contains(res.Stdout, "hello") {
		t.Errorf("expected stdout to contain 'hello', got %q", res.Stdout)
	}

	assertNoOrphanContainers(t, cli)
}

// Acceptance 2: Infinite loop is killed at the timeout, status timeout
func TestAcceptance_Timeout(t *testing.T) {
	cli := newTestDockerClient(t)
	defer func() { _ = cli.Close() }()

	reg := languages.NewRegistry()
	py, _ := reg.Get("python")

	limits := py.DefaultLimits
	limits.TimeoutMS = 1000 // 1 second timeout

	s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")
	res, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:      fmt.Sprintf("test-timeout-%d", time.Now().UnixNano()),
		Language:   py,
		SourceCode: "import time\nwhile True:\n    time.sleep(0.1)\n",
		Limits:     limits,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Status != sandbox.StatusTimeout {
		t.Errorf("expected status timeout, got %s", res.Status)
	}

	assertNoOrphanContainers(t, cli)
}

// Acceptance 3: Allocating large memory under strict limit yields oom_killed
func TestAcceptance_OOMKilled(t *testing.T) {
	cli := newTestDockerClient(t)
	defer func() { _ = cli.Close() }()

	reg := languages.NewRegistry()
	py, _ := reg.Get("python")

	limits := py.DefaultLimits
	limits.MemoryMB = 64 // 64 MB cap

	s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")
	res, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:      fmt.Sprintf("test-oom-%d", time.Now().UnixNano()),
		Language:   py,
		SourceCode: "a = [bytearray(1024*1024*10) for _ in range(20)]", // Attempts 200 MB
		Limits:     limits,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Status != sandbox.StatusOOMKilled {
		t.Errorf("expected status oom_killed, got %s", res.Status)
	}

	assertNoOrphanContainers(t, cli)
}

// Acceptance 4: Fork bomb is contained by PID limit and does not crash host
func TestAcceptance_ForkBomb(t *testing.T) {
	cli := newTestDockerClient(t)
	defer func() { _ = cli.Close() }()

	reg := languages.NewRegistry()
	py, _ := reg.Get("python")

	limits := py.DefaultLimits
	limits.TimeoutMS = 3000
	limits.PidsLimit = 32

	s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")
	res, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:    fmt.Sprintf("test-forkbomb-%d", time.Now().UnixNano()),
		Language: py,
		SourceCode: `
import os, time
try:
    while True:
        os.fork()
except (BlockingIOError, OSError):
    print("fork bomb contained by PID limit")
`,
		Limits: limits,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Either contained gracefully by catch or killed by timeout
	if res.Status != sandbox.StatusCompleted && res.Status != sandbox.StatusTimeout {
		t.Errorf("unexpected fork bomb terminal status: %s", res.Status)
	}

	assertNoOrphanContainers(t, cli)
}

// Acceptance 5: Writing to the root filesystem fails; network calls fail
func TestAcceptance_FilesystemAndNetworkIsolation(t *testing.T) {
	cli := newTestDockerClient(t)
	defer func() { _ = cli.Close() }()

	reg := languages.NewRegistry()
	py, _ := reg.Get("python")

	s := sandbox.NewDockerSandbox(cli, "runc", "../../deploy/compose/seccomp.json")

	// Test 5a: Rootfs write fails
	resFs, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:      fmt.Sprintf("test-rootfs-%d", time.Now().UnixNano()),
		Language:   py,
		SourceCode: "open('/etc/hacked.txt', 'w').write('fail')",
		Limits:     py.DefaultLimits,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resFs.Status != sandbox.StatusFailed {
		t.Errorf("expected status failed when writing to rootfs, got %s", resFs.Status)
	}
	if !strings.Contains(resFs.Stderr, "Read-only file system") {
		t.Errorf("expected Read-only file system error, got %s", resFs.Stderr)
	}

	// Test 5b: Network calls fail
	resNet, err := s.Run(context.Background(), sandbox.ExecutionSpec{
		JobID:    fmt.Sprintf("test-network-%d", time.Now().UnixNano()),
		Language: py,
		SourceCode: `
import urllib.request
try:
    urllib.request.urlopen("http://1.1.1.1", timeout=1)
    print("NET_SUCCESS")
except Exception:
    print("NET_FAILED")
`,
		Limits: py.DefaultLimits,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(resNet.Stdout, "NET_FAILED") {
		t.Errorf("expected network call to fail, got stdout: %s", resNet.Stdout)
	}

	assertNoOrphanContainers(t, cli)
}

func assertNoOrphanContainers(t *testing.T, cli *client.Client) {
	t.Helper()
	containers, err := cli.ContainerList(context.Background(), container.ListOptions{All: true})
	if err != nil {
		t.Fatalf("failed to query containers: %v", err)
	}
	for _, c := range containers {
		if _, ok := c.Labels["kairo.job_id"]; ok {
			t.Errorf("leaked orphan container found: %s (labels: %v)", c.ID, c.Labels)
		}
	}
}
