package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Arnav7x/kairo/internal/config"
	"github.com/Arnav7x/kairo/internal/observability"
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
	defer rdb.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown handling
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	logger.Info("kairo-worker is idle waiting for jobs (Phase 0 foundation ready)")

	// Worker heartbeat / background loop simulator until Phase 3
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				logger.Debug("worker heartbeat tick")
			}
		}
	}()

	sig := <-shutdown
	logger.Info("received shutdown signal, draining worker...", "signal", sig.String())
	cancel()

	// Wait brief interval to finish active tasks
	time.Sleep(500 * time.Millisecond)
	logger.Info("kairo-worker drained and exited cleanly")
}
