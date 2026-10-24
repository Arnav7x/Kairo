package events

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// RedisSink persists each event for replay and publishes it for live consumers.
type RedisSink struct {
	client *redis.Client
}

// NewRedisSink creates an event sink backed by Redis Streams and Pub/Sub.
func NewRedisSink(client *redis.Client) *RedisSink {
	return &RedisSink{client: client}
}

// StreamKey returns the Redis Stream used to replay a job's output.
func StreamKey(jobID string) string {
	return fmt.Sprintf("kairo:job:%s:events", jobID)
}

// ChannelKey returns the Pub/Sub channel used for a job's live output.
func ChannelKey(jobID string) string {
	return fmt.Sprintf("kairo:job:%s:events:live", jobID)
}

// Publish writes an event to both the per-job Stream and its live channel.
func (s *RedisSink) Publish(ctx context.Context, event Event) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	if err := s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamKey(event.JobID),
		Values: map[string]any{"event": string(payload)},
	}).Err(); err != nil {
		return fmt.Errorf("append event to stream: %w", err)
	}
	if err := s.client.Publish(ctx, ChannelKey(event.JobID), payload).Err(); err != nil {
		return fmt.Errorf("publish live event: %w", err)
	}
	return nil
}
