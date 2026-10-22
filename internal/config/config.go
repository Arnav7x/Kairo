package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
)

// Config holds all platform configurations loaded from environment variables.
type Config struct {
	// Service
	Port           string
	Environment    string
	LogLevel       string

	// Redis & DB
	RedisURL       string
	DatabaseURL    string

	// Runtime & Worker
	Runtime           string        // "runc" or "runsc"
	WorkerConcurrency int           // default 4
	ReaperMaxAge      time.Duration // default 5m

	// Resource ceilings
	MaxTimeoutMS     int64 // default 30000 ms
	MaxMemoryMB      int64 // default 1024 MB
	MaxOutputBytes   int64 // default 1048576 (1 MB)
	MaxSourceBytes   int64 // default 262144 (256 KB)
	SeccompProfile   string
}

// LoadFromEnv parses environment variables with default fallbacks and validation.
func LoadFromEnv() (*Config, error) {
	cfg := &Config{
		Port:              getEnv("PORT", "8080"),
		Environment:       getEnv("KAIRO_ENV", "development"),
		LogLevel:          getEnv("KAIRO_LOG_LEVEL", "info"),
		RedisURL:          getEnv("KAIRO_REDIS_URL", "redis://localhost:6379"),
		DatabaseURL:       getEnv("KAIRO_DATABASE_URL", ""),
		Runtime:           getEnv("KAIRO_RUNTIME", "runc"),
		WorkerConcurrency: getEnvAsInt("KAIRO_WORKER_CONCURRENCY", 4),
		ReaperMaxAge:      getEnvAsDuration("KAIRO_REAPER_MAX_AGE", 5*time.Minute),
		MaxTimeoutMS:      getEnvAsInt64("KAIRO_MAX_TIMEOUT_MS", 30000),
		MaxMemoryMB:       getEnvAsInt64("KAIRO_MAX_MEMORY_MB", 1024),
		MaxOutputBytes:    getEnvAsInt64("KAIRO_MAX_OUTPUT_BYTES", 1048576),
		MaxSourceBytes:    getEnvAsInt64("KAIRO_MAX_SOURCE_BYTES", 262144),
		SeccompProfile:    getEnv("KAIRO_SECCOMP_PROFILE", "deploy/compose/seccomp.json"),
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("config validation failed: %w", err)
	}

	return cfg, nil
}

// Validate ensures runtime parameters satisfy limits and format contracts.
func (c *Config) Validate() error {
	if c.RedisURL == "" {
		return fmt.Errorf("KAIRO_REDIS_URL must not be empty")
	}
	if _, err := url.Parse(c.RedisURL); err != nil {
		return fmt.Errorf("invalid KAIRO_REDIS_URL: %w", err)
	}

	if c.Runtime != "runc" && c.Runtime != "runsc" {
		return fmt.Errorf("invalid KAIRO_RUNTIME: %q (must be runc or runsc)", c.Runtime)
	}

	if c.WorkerConcurrency <= 0 {
		return fmt.Errorf("KAIRO_WORKER_CONCURRENCY must be greater than 0")
	}

	if c.MaxTimeoutMS <= 0 {
		return fmt.Errorf("KAIRO_MAX_TIMEOUT_MS must be greater than 0")
	}

	if c.MaxMemoryMB <= 0 {
		return fmt.Errorf("KAIRO_MAX_MEMORY_MB must be greater than 0")
	}

	if c.MaxOutputBytes <= 0 {
		return fmt.Errorf("KAIRO_MAX_OUTPUT_BYTES must be greater than 0")
	}

	if c.MaxSourceBytes <= 0 {
		return fmt.Errorf("KAIRO_MAX_SOURCE_BYTES must be greater than 0")
	}

	return nil
}

func getEnv(key, defaultVal string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return defaultVal
}

func getEnvAsInt(key string, defaultVal int) int {
	valStr := getEnv(key, "")
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.Atoi(valStr)
	if err != nil {
		return defaultVal
	}
	return val
}

func getEnvAsInt64(key string, defaultVal int64) int64 {
	valStr := getEnv(key, "")
	if valStr == "" {
		return defaultVal
	}
	val, err := strconv.ParseInt(valStr, 10, 64)
	if err != nil {
		return defaultVal
	}
	return val
}

func getEnvAsDuration(key string, defaultVal time.Duration) time.Duration {
	valStr := getEnv(key, "")
	if valStr == "" {
		return defaultVal
	}
	val, err := time.ParseDuration(valStr)
	if err != nil {
		return defaultVal
	}
	return val
}
