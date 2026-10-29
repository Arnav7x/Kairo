// Package queue provides the Redis Streams transport for sandbox jobs.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/redis/go-redis/v9"
)

const (
	// JobsStream contains submitted sandbox jobs.
	JobsStream = "kairo:jobs"
	// DeadLetterStream retains messages that exceeded their delivery budget.
	DeadLetterStream = "kairo:jobs:dead"
)

// Job is the language-neutral payload stored in the jobs stream.
type Job struct {
	ID         string           `json:"id"`
	Language   string           `json:"language"`
	SourceCode string           `json:"source_code"`
	Stdin      string           `json:"stdin,omitempty"`
	Args       []string         `json:"args,omitempty"`
	Limits     languages.Limits `json:"limits"`
}

// Message is a Redis Stream entry containing a job.
type Message struct {
	ID         string
	Job        Job
	Deliveries int64
}

// Producer appends submitted jobs to the stream.
type Producer struct{ client *redis.Client }

// NewProducer creates a job producer.
func NewProducer(client *redis.Client) *Producer { return &Producer{client: client} }

// Enqueue validates and appends a job.
func (p *Producer) Enqueue(ctx context.Context, job Job) error {
	if job.ID == "" || job.Language == "" || job.SourceCode == "" {
		return errors.New("job id, language, and source code are required")
	}
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}
	if err := p.client.XAdd(ctx, &redis.XAddArgs{Stream: JobsStream, Values: map[string]any{"job": string(payload)}}).Err(); err != nil {
		return fmt.Errorf("enqueue job: %w", err)
	}
	return nil
}

// Consumer reads and acknowledges jobs through a Redis consumer group.
type Consumer struct {
	client   *redis.Client
	group    string
	name     string
	maxTries int64
}

// NewConsumer creates a consumer for a named group and worker identity.
func NewConsumer(client *redis.Client, group, name string, maxTries int64) *Consumer {
	if maxTries <= 0 {
		maxTries = 3
	}
	return &Consumer{client: client, group: group, name: name, maxTries: maxTries}
}

// Name returns the Redis consumer identity.
func (c *Consumer) Name() string { return c.name }

// EnsureGroup creates the consumer group without failing if it already exists.
func (c *Consumer) EnsureGroup(ctx context.Context) error {
	err := c.client.XGroupCreateMkStream(ctx, JobsStream, c.group, "0").Err()
	if err != nil && !isBusyGroup(err) {
		return fmt.Errorf("create jobs group: %w", err)
	}
	return nil
}

// Read blocks briefly for new jobs assigned to this group.
func (c *Consumer) Read(ctx context.Context, block time.Duration) ([]Message, error) {
	streams, err := c.client.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group: c.group, Consumer: c.name, Streams: []string{JobsStream, ">"}, Count: 1, Block: block,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read jobs: %w", err)
	}
	return c.decode(streams)
}

// ClaimIdle transfers jobs abandoned by another consumer after minIdle.
func (c *Consumer) ClaimIdle(ctx context.Context, minIdle time.Duration) ([]Message, error) {
	messages, _, err := c.client.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream: JobsStream, Group: c.group, Consumer: c.name, MinIdle: minIdle, Start: "0-0", Count: 10,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim idle jobs: %w", err)
	}
	return c.decode([]redis.XStream{{Stream: JobsStream, Messages: messages}})
}

// Ack acknowledges successful, skipped, or dead-lettered jobs.
func (c *Consumer) Ack(ctx context.Context, messageID string) error {
	return c.client.XAck(ctx, JobsStream, c.group, messageID).Err()
}

// ShouldDeadLetter reports whether a message has exhausted delivery attempts.
func (c *Consumer) ShouldDeadLetter(message Message) bool { return message.Deliveries >= c.maxTries }

// DeadLetter records the failed message before acknowledging it from the jobs stream.
func (c *Consumer) DeadLetter(ctx context.Context, message Message, reason string) error {
	payload, err := json.Marshal(message.Job)
	if err != nil {
		return fmt.Errorf("marshal dead letter: %w", err)
	}
	pipe := c.client.TxPipeline()
	pipe.XAdd(ctx, &redis.XAddArgs{Stream: DeadLetterStream, Values: map[string]any{"job": string(payload), "reason": reason, "deliveries": message.Deliveries}})
	pipe.XAck(ctx, JobsStream, c.group, message.ID)
	_, err = pipe.Exec(ctx)
	return err
}

// IsTerminal returns whether a job already has a durable terminal result.
func IsTerminal(ctx context.Context, client *redis.Client, jobID string) (bool, error) {
	n, err := client.Exists(ctx, terminalKey(jobID)).Result()
	return n == 1, err
}

// MarkTerminal records the result before acknowledging the stream entry.
func MarkTerminal(ctx context.Context, client *redis.Client, jobID string, result *sandbox.ExecutionResult) error {
	payload, err := json.Marshal(result)
	if err != nil {
		return err
	}
	terminalEvent, _ := json.Marshal(map[string]any{
		"event":             "result",
		"id":                "terminal",
		"job_id":            jobID,
		"status":            result.Status,
		"exit_code":         result.ExitCode,
		"stdout":            result.Stdout,
		"stderr":            result.Stderr,
		"duration_ms":       result.Duration.Milliseconds(),
		"peak_memory_bytes": result.PeakMemoryBytes,
		"error_message":     result.ErrorMessage,
	})
	pipe := client.TxPipeline()
	pipe.Set(ctx, terminalKey(jobID), payload, 0)
	pipe.Del(ctx, processingKey(jobID))
	pipe.Publish(ctx, fmt.Sprintf("kairo:job:%s:events:live", jobID), terminalEvent)
	pipe.Publish(ctx, "kairo:jobs:terminal", terminalEvent)
	_, err = pipe.Exec(ctx)
	return err
}

// AcquireProcessing prevents concurrent duplicate execution. The lock expires
// so a crashed worker's job can be reclaimed.
func AcquireProcessing(ctx context.Context, client *redis.Client, jobID, worker string, ttl time.Duration) (bool, error) {
	return client.SetNX(ctx, processingKey(jobID), worker, ttl).Result()
}

// IsCancelled checks the per-job cancellation key.
func IsCancelled(ctx context.Context, client *redis.Client, jobID string) (bool, error) {
	n, err := client.Exists(ctx, CancelKey(jobID)).Result()
	return n == 1, err
}

// CancelKey is the Redis key watched by active workers.
func CancelKey(jobID string) string { return fmt.Sprintf("kairo:job:%s:cancel", jobID) }

func terminalKey(jobID string) string   { return fmt.Sprintf("kairo:job:%s:terminal", jobID) }
func processingKey(jobID string) string { return fmt.Sprintf("kairo:job:%s:processing", jobID) }

func (c *Consumer) decode(streams []redis.XStream) ([]Message, error) {
	var decoded []Message
	for _, stream := range streams {
		for _, raw := range stream.Messages {
			payload, ok := raw.Values["job"].(string)
			if !ok {
				return nil, fmt.Errorf("message %s has no job payload", raw.ID)
			}
			var job Job
			if err := json.Unmarshal([]byte(payload), &job); err != nil {
				return nil, fmt.Errorf("decode message %s: %w", raw.ID, err)
			}
			deliveries, err := c.deliveryCount(context.Background(), raw.ID)
			if err != nil {
				return nil, err
			}
			decoded = append(decoded, Message{ID: raw.ID, Job: job, Deliveries: deliveries})
		}
	}
	return decoded, nil
}

func (c *Consumer) deliveryCount(ctx context.Context, messageID string) (int64, error) {
	pending, err := c.client.XPendingExt(ctx, &redis.XPendingExtArgs{Stream: JobsStream, Group: c.group, Start: messageID, End: messageID, Count: 1}).Result()
	if err != nil || len(pending) == 0 {
		return 1, err
	}
	return pending[0].RetryCount, nil
}

func isBusyGroup(err error) bool { return len(err.Error()) >= 10 && err.Error()[:10] == "BUSYGROUP " }
