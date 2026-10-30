// Package events defines execution-output events and their delivery contract.
package events

import (
	"context"
	"time"
)

// Stream identifies the source of an output event.
type Stream string

const (
	// StreamStdout contains normal program output.
	StreamStdout Stream = "stdout"
	// StreamStderr contains diagnostic program output.
	StreamStderr Stream = "stderr"
)

// Event is a chunk of output produced by a sandboxed job.
type Event struct {
	ID        string    `json:"id,omitempty"`
	JobID     string    `json:"job_id"`
	Phase     string    `json:"phase,omitempty"`
	Stream    Stream    `json:"stream"`
	Data      string    `json:"data"`
	Timestamp time.Time `json:"timestamp"`
}

// Sink receives live execution events. Implementations may forward them to
// Redis, WebSockets, a database, or a test double.
type Sink interface {
	Publish(context.Context, Event) error
}
