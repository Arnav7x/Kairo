package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

// HealthHandler returns standard healthz and readyz handlers.
type HealthHandler struct {
	redisClient *redis.Client
	dbConnStr   string
}

// NewHealthHandler creates a HealthHandler instance.
func NewHealthHandler(redisClient *redis.Client, dbConnStr string) *HealthHandler {
	return &HealthHandler{
		redisClient: redisClient,
		dbConnStr:   dbConnStr,
	}
}

// Healthz responds 200 OK as a liveness probe.
func (h *HealthHandler) Healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Readyz checks connectivity to Redis and PostgreSQL.
func (h *HealthHandler) Readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	checks := make(map[string]string)
	allHealthy := true

	// Check Redis
	if h.redisClient != nil {
		if err := h.redisClient.Ping(ctx).Err(); err != nil {
			checks["redis"] = "unhealthy: " + err.Error()
			allHealthy = false
		} else {
			checks["redis"] = "ok"
		}
	} else {
		checks["redis"] = "disabled"
	}

	// Check Postgres if configured
	if h.dbConnStr != "" {
		conn, err := pgx.Connect(ctx, h.dbConnStr)
		if err != nil {
			checks["postgres"] = "unhealthy: " + err.Error()
			allHealthy = false
		} else {
			defer conn.Close(ctx)
			if err := conn.Ping(ctx); err != nil {
				checks["postgres"] = "unhealthy: " + err.Error()
				allHealthy = false
			} else {
				checks["postgres"] = "ok"
			}
		}
	} else {
		checks["postgres"] = "skipped (no DSN)"
	}

	w.Header().Set("Content-Type", "application/json")
	if !allHealthy {
		w.WriteHeader(http.StatusServiceUnavailable)
	} else {
		w.WriteHeader(http.StatusOK)
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"ready":  allHealthy,
		"checks": checks,
	})
}
