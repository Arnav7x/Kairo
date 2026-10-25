package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Arnav7x/kairo/internal/config"
	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/observability"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/Arnav7x/kairo/internal/worker"
	"github.com/docker/docker/client"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load configuration: %v\n", err)
		os.Exit(1)
	}

	logger := observability.InitLogger(cfg.LogLevel)
	logger.Info("starting kairo-worker service",
		"env", cfg.Environment,
		"concurrency", cfg.WorkerConcurrency,
		"runtime", cfg.Runtime,
	)

	// Validate Redis connectivity
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Error("failed to parse redis url", "error", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	defer func() {
		if err := rdb.Close(); err != nil {
			logger.Error("failed to close Redis client", "error", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown handling
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	dockerClient, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		logger.Error("failed to create Docker client", "error", err)
		os.Exit(1)
	}
	defer func() { _ = dockerClient.Close() }()

	name, err := os.Hostname()
	if err != nil {
		name = fmt.Sprintf("worker-%d", os.Getpid())
	}
	executor := sandbox.NewDockerSandbox(dockerClient, cfg.Runtime, cfg.SeccompProfile)
	runner := worker.New(rdb, executor, languages.NewRegistry(), worker.Options{
		ConsumerName: name,
		Concurrency:  cfg.WorkerConcurrency,
		ClaimAfter:   time.Duration(cfg.MaxTimeoutMS)*time.Millisecond + 5*time.Second,
		Reap: func(reapCtx context.Context) error {
			return sandbox.CleanOrphanedContainers(reapCtx, dockerClient, cfg.ReaperMaxAge)
		},
	})

	go func() {
		sig := <-shutdown
		logger.Info("received shutdown signal, draining worker...", "signal", sig.String())
		cancel()
	}()

	logger.Info("kairo-worker is consuming jobs")
	if err := runner.Run(ctx); err != nil {
		logger.Error("worker stopped with error", "error", err)
		os.Exit(1)
	}
	logger.Info("kairo-worker drained and exited cleanly")
}
