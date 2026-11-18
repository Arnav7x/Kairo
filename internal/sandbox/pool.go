package sandbox

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// WarmContainer represents a pre-created idle container ready for instant execution.
type WarmContainer struct {
	ID        string
	Language  string
	Runtime   string
	CreatedAt time.Time
}

// ContainerPool manages a standby set of pre-created containers to reduce cold-start latency.
type ContainerPool struct {
	cli        *client.Client
	runtime    string
	seccomp    string
	targetSize int
	mu         sync.Mutex
	pool       map[string][]*WarmContainer
	closed     bool
}

// NewContainerPool initializes a container warming pool.
func NewContainerPool(cli *client.Client, runtime, seccompPath string, targetSizePerLang int) *ContainerPool {
	if targetSizePerLang < 0 {
		targetSizePerLang = 0
	}
	return &ContainerPool{
		cli:        cli,
		runtime:    runtime,
		seccomp:    seccompPath,
		targetSize: targetSizePerLang,
		pool:       make(map[string][]*WarmContainer),
	}
}

// Acquire pulls a warm container if available; returns nil if the pool is empty.
func (p *ContainerPool) Acquire(language string) *WarmContainer {
	p.mu.Lock()
	defer p.mu.Unlock()

	items := p.pool[language]
	if len(items) == 0 {
		return nil
	}
	item := items[0]
	p.pool[language] = items[1:]
	return item
}

// Warm creates an idle standby container for the given language.
func (p *ContainerPool) Warm(ctx context.Context, langConfig languages.LanguageConfig) (*WarmContainer, error) {
	if p.targetSize <= 0 {
		return nil, nil
	}

	p.mu.Lock()
	if len(p.pool[langConfig.ID]) >= p.targetSize {
		p.mu.Unlock()
		return nil, nil
	}
	p.mu.Unlock()

	containerConfig := &container.Config{
		Image:           langConfig.Image,
		Cmd:             []string{"sleep", "infinity"},
		Tty:             false,
		OpenStdin:       true,
		StdinOnce:       false,
		AttachStdin:     true,
		AttachStdout:    true,
		AttachStderr:    true,
		NetworkDisabled: true,
		Labels: map[string]string{
			"kairo.warm_pool": "true",
			"kairo.language":  langConfig.ID,
		},
	}

	hostConfig := &container.HostConfig{
		NetworkMode: "none",
		CapDrop:     []string{"ALL"},
	}
	if p.runtime != "runc" && p.runtime != "" {
		hostConfig.Runtime = p.runtime
	}

	resp, err := p.cli.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, "")
	if err != nil {
		return nil, fmt.Errorf("create warm container: %w", err)
	}

	warm := &WarmContainer{
		ID:        resp.ID,
		Language:  langConfig.ID,
		Runtime:   p.runtime,
		CreatedAt: time.Now(),
	}

	p.mu.Lock()
	p.pool[langConfig.ID] = append(p.pool[langConfig.ID], warm)
	p.mu.Unlock()

	return warm, nil
}

// Close destroys all idle warm containers.
func (p *ContainerPool) Close(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true

	for lang, items := range p.pool {
		for _, item := range items {
			_ = p.cli.ContainerRemove(ctx, item.ID, container.RemoveOptions{Force: true})
		}
		delete(p.pool, lang)
	}
}
