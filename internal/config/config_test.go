package config

import (
	"os"
	"testing"
	"time"
)

func TestConfigDefaults(t *testing.T) {
	// Clear any overrides for test
	_ = os.Unsetenv("KAIRO_REDIS_URL")
	_ = os.Unsetenv("KAIRO_RUNTIME")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("expected valid default config, got err: %v", err)
	}

	if cfg.Port != "8080" {
		t.Errorf("expected port 8080, got %s", cfg.Port)
	}
	if cfg.Runtime != "runc" {
		t.Errorf("expected runtime runc, got %s", cfg.Runtime)
	}
	if cfg.WorkerConcurrency != 4 {
		t.Errorf("expected concurrency 4, got %d", cfg.WorkerConcurrency)
	}
	if cfg.MaxTimeoutMS != 30000 {
		t.Errorf("expected max timeout 30000, got %d", cfg.MaxTimeoutMS)
	}
	if cfg.ReaperMaxAge != 5*time.Minute {
		t.Errorf("expected reaper max age 5m, got %v", cfg.ReaperMaxAge)
	}
}

func TestConfigValidation(t *testing.T) {
	cfg := &Config{
		RedisURL:          "redis://localhost:6379",
		Runtime:           "invalid-runtime",
		WorkerConcurrency: 4,
		MaxTimeoutMS:      30000,
		MaxMemoryMB:       1024,
		MaxOutputBytes:    1048576,
		MaxSourceBytes:    262144,
	}

	if err := cfg.Validate(); err == nil {
		t.Errorf("expected error for invalid runtime, got nil")
	}

	cfg.Runtime = "runc"
	cfg.WorkerConcurrency = 0
	if err := cfg.Validate(); err == nil {
		t.Errorf("expected error for 0 worker concurrency, got nil")
	}

	cfg.WorkerConcurrency = 2
	cfg.RedisURL = ""
	if err := cfg.Validate(); err == nil {
		t.Errorf("expected error for empty redis url, got nil")
	}
}
