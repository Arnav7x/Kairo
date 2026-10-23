package sandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-units"
)

// TerminalStatus represents the terminal state of a job.
type TerminalStatus string

const (
	StatusCompleted     TerminalStatus = "completed"
	StatusFailed        TerminalStatus = "failed"
	StatusTimeout       TerminalStatus = "timeout"
	StatusOOMKilled     TerminalStatus = "oom_killed"
	StatusOutputLimit   TerminalStatus = "output_limit"
	StatusCancelled     TerminalStatus = "cancelled"
	StatusInternalError TerminalStatus = "internal_error"
)

// ExecutionSpec defines the input requirements to execute a user's code.
type ExecutionSpec struct {
	JobID      string
	Language   languages.LanguageConfig
	SourceCode string
	Stdin      string
	Args       []string
	Limits     languages.Limits
}

// ExecutionResult holds the outcome of a sandbox execution.
type ExecutionResult struct {
	Status          TerminalStatus
	ExitCode        int
	Stdout          string
	Stderr          string
	Duration        time.Duration
	PeakMemoryBytes uint64
	ErrorMessage    string
}

// Executor interface for executing code sandboxes.
type Executor interface {
	Run(ctx context.Context, spec ExecutionSpec) (*ExecutionResult, error)
}

// DockerSandbox manages the container lifecycle using the Docker Engine API.
type DockerSandbox struct {
	dockerClient   *client.Client
	runtime        string // "runc" or "runsc"
	seccompProfile string
}

// NewDockerSandbox creates a DockerSandbox instance.
func NewDockerSandbox(dockerClient *client.Client, runtime, seccompProfile string) *DockerSandbox {
	if runtime == "" {
		runtime = "runc"
	}
	return &DockerSandbox{
		dockerClient:   dockerClient,
		runtime:        runtime,
		seccompProfile: seccompProfile,
	}
}

// Run executes a sandbox container in accordance with Section 6 security hardening.
func (d *DockerSandbox) Run(ctx context.Context, spec ExecutionSpec) (*ExecutionResult, error) {
	startTime := time.Now()

	// 1. Enforce wall-clock timeout outside container
	timeout := time.Duration(spec.Limits.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 2. Prepare container resource limits & security opts
	memLimit := spec.Limits.MemoryMB * 1024 * 1024
	if memLimit <= 0 {
		memLimit = 256 * 1024 * 1024
	}

	pidsLimit := spec.Limits.PidsLimit
	if pidsLimit <= 0 {
		pidsLimit = 64
	}

	cpuNano := spec.Limits.CPUNanoCores
	if cpuNano <= 0 {
		cpuNano = 500_000_000 // 0.5 CPU
	}

	// Read custom seccomp profile if available
	securityOpts := []string{"no-new-privileges:true"}
	if d.seccompProfile != "" {
		if content, err := os.ReadFile(d.seccompProfile); err == nil && len(content) > 0 {
			securityOpts = append(securityOpts, fmt.Sprintf("seccomp=%s", string(content)))
		}
	}

	containerConfig := &container.Config{
		Image:           spec.Language.Image,
		User:            "10001:10001",
		NetworkDisabled: true,
		WorkingDir:      "/workspace",
		Cmd:             spec.Language.RunCmd,
		AttachStdout:    true,
		AttachStderr:    true,
		AttachStdin:     spec.Stdin != "",
		OpenStdin:       spec.Stdin != "",
		StdinOnce:       spec.Stdin != "",
		Labels: map[string]string{
			"kairo.job_id":     spec.JobID,
			"kairo.created_at": fmt.Sprintf("%d", startTime.Unix()),
		},
	}

	hostConfig := &container.HostConfig{
		Resources: container.Resources{
			Memory:     memLimit,
			MemorySwap: memLimit, // Swap off: MemorySwap == Memory
			NanoCPUs:   cpuNano,
			PidsLimit:  &pidsLimit,
			Ulimits: []*units.Ulimit{
				{Name: "nofile", Soft: 256, Hard: 256},
				{Name: "nproc", Soft: 64, Hard: 64},
				{Name: "core", Soft: 0, Hard: 0},
			},
		},
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		CapDrop:        []string{"ALL"},
		SecurityOpt:    securityOpts,
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Target: "/workspace",
			},
		},
		Tmpfs: map[string]string{
			"/tmp": "rw,noexec,nosuid,size=16m",
		},
	}

	if d.runtime != "runc" && d.runtime != "" {
		hostConfig.Runtime = d.runtime
	}

	// 3. Create Container
	createResp, err := d.dockerClient.ContainerCreate(execCtx, containerConfig, hostConfig, nil, nil, "")
	if err != nil {
		return &ExecutionResult{
			Status:       StatusInternalError,
			ErrorMessage: fmt.Sprintf("failed to create sandbox container: %v", err),
			Duration:     time.Since(startTime),
		}, nil
	}

	containerID := createResp.ID

	// Mandatory: Always remove container on exit
	defer func() {
		removeCtx, removeCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer removeCancel()
		_ = d.dockerClient.ContainerRemove(removeCtx, containerID, container.RemoveOptions{
			Force:         true,
			RemoveVolumes: true,
		})
	}()

	// 4. Copy source file into /workspace via Docker Archive API
	tarArchive, err := createTarArchive(spec.Language.Filename, spec.SourceCode)
	if err != nil {
		return &ExecutionResult{
			Status:       StatusInternalError,
			ErrorMessage: fmt.Sprintf("failed to archive source code: %v", err),
			Duration:     time.Since(startTime),
		}, nil
	}

	if err := d.dockerClient.CopyToContainer(execCtx, containerID, "/workspace", tarArchive, types.CopyToContainerOptions{}); err != nil {
		return &ExecutionResult{
			Status:       StatusInternalError,
			ErrorMessage: fmt.Sprintf("failed to copy source into container: %v", err),
			Duration:     time.Since(startTime),
		}, nil
	}

	// 5. Attach stdin if provided
	if spec.Stdin != "" {
		hijacked, err := d.dockerClient.ContainerAttach(execCtx, containerID, container.AttachOptions{
			Stream: true,
			Stdin:  true,
		})
		if err == nil {
			go func() {
				defer hijacked.Close()
				_, _ = io.WriteString(hijacked.Conn, spec.Stdin)
			}()
		}
	}

	// 6. Start Container
	if err := d.dockerClient.ContainerStart(execCtx, containerID, container.StartOptions{}); err != nil {
		return &ExecutionResult{
			Status:       StatusInternalError,
			ErrorMessage: fmt.Sprintf("failed to start container: %v", err),
			Duration:     time.Since(startTime),
		}, nil
	}

	// 7. Wait for container execution or timeout
	statusCh, errCh := d.dockerClient.ContainerWait(execCtx, containerID, container.WaitConditionNotRunning)

	var exitCode int
	var timeoutKilled bool

	select {
	case err := <-errCh:
		if err != nil {
			// Check if context timed out
			if execCtx.Err() != nil {
				timeoutKilled = true
				// Kill container
				killCtx, killCancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = d.dockerClient.ContainerKill(killCtx, containerID, "SIGKILL")
				killCancel()
			} else {
				return &ExecutionResult{
					Status:       StatusInternalError,
					ErrorMessage: fmt.Sprintf("error waiting for container: %v", err),
					Duration:     time.Since(startTime),
				}, nil
			}
		}
	case waitResp := <-statusCh:
		exitCode = int(waitResp.StatusCode)
	case <-execCtx.Done():
		timeoutKilled = true
		killCtx, killCancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = d.dockerClient.ContainerKill(killCtx, containerID, "SIGKILL")
		killCancel()
	}

	// 8. Inspect container for OOM kill and exit status
	inspectCtx, inspectCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer inspectCancel()
	inspect, err := d.dockerClient.ContainerInspect(inspectCtx, containerID)

	oomKilled := false
	if err == nil && inspect.State != nil {
		oomKilled = inspect.State.OOMKilled
		if inspect.State.ExitCode != 0 {
			exitCode = inspect.State.ExitCode
		}
	}

	// 9. Collect output logs (demultiplex stdout & stderr)
	logsCtx, logsCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer logsCancel()

	logReader, err := d.dockerClient.ContainerLogs(logsCtx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
	})

	var stdoutBuf, stderrBuf bytes.Buffer
	if err == nil {
		defer func() {
			_ = logReader.Close()
		}()
		_, _ = stdcopy.StdCopy(&stdoutBuf, &stderrBuf, logReader)
	}

	duration := time.Since(startTime)

	// Check output limits
	maxOutput := spec.Limits.OutputBytes
	if maxOutput <= 0 {
		maxOutput = 1048576 // 1MB default
	}

	if int64(stdoutBuf.Len()+stderrBuf.Len()) > maxOutput {
		return &ExecutionResult{
			Status:   StatusOutputLimit,
			ExitCode: exitCode,
			Stdout:   stdoutBuf.String(),
			Stderr:   stderrBuf.String(),
			Duration: duration,
		}, nil
	}

	// Map to Terminal Status
	var finalStatus TerminalStatus
	switch {
	case oomKilled:
		finalStatus = StatusOOMKilled
	case timeoutKilled:
		finalStatus = StatusTimeout
	case exitCode == 0:
		finalStatus = StatusCompleted
	default:
		finalStatus = StatusFailed
	}

	return &ExecutionResult{
		Status:   finalStatus,
		ExitCode: exitCode,
		Stdout:   stdoutBuf.String(),
		Stderr:   stderrBuf.String(),
		Duration: duration,
	}, nil
}

// createTarArchive produces an in-memory tar stream for Docker's CopyToContainer API.
func createTarArchive(filename, content string) (io.Reader, error) {
	buf := new(bytes.Buffer)
	tw := tar.NewWriter(buf)

	data := []byte(content)
	hdr := &tar.Header{
		Name:     filename,
		Mode:     0644,
		Uid:      10001,
		Gid:      10001,
		Size:     int64(len(data)),
		ModTime:  time.Now(),
		Typeflag: tar.TypeReg,
	}

	if err := tw.WriteHeader(hdr); err != nil {
		return nil, fmt.Errorf("tar write header error: %w", err)
	}

	if _, err := tw.Write(data); err != nil {
		return nil, fmt.Errorf("tar write data error: %w", err)
	}

	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("tar close error: %w", err)
	}

	return bytes.NewReader(buf.Bytes()), nil
}

// CleanOrphanedContainers provides a reaper routine to remove labeled containers older than maxAge.
func CleanOrphanedContainers(ctx context.Context, cli *client.Client, maxAge time.Duration) error {
	containers, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return err
	}

	now := time.Now()
	for _, c := range containers {
		if jobID, ok := c.Labels["kairo.job_id"]; ok && jobID != "" {
			created := time.Unix(c.Created, 0)
			if now.Sub(created) > maxAge {
				_ = cli.ContainerKill(ctx, c.ID, "SIGKILL")
				_ = cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true, RemoveVolumes: true})
			}
		}
	}
	return nil
}
