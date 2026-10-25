// Package worker runs sandbox jobs claimed from the Redis Streams queue.
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Arnav7x/kairo/internal/events"
	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/queue"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/redis/go-redis/v9"
)

const (
	defaultGroup       = "kairo-workers"
	defaultMaxAttempts = 3
	defaultGrace       = 5 * time.Second
)

// Runner consumes jobs, executes them, and records terminal state before ACK.
type Runner struct {
	client       *redis.Client
	consumer     *queue.Consumer
	executor     sandbox.Executor
	registry     *languages.Registry
	concurrency  int
	claimAfter   time.Duration
	drainAfter   time.Duration
	heartbeatTTL time.Duration
	reap         func(context.Context) error

	active atomic.Int64
}

// Options configures a Runner.
type Options struct {
	Group        string
	ConsumerName string
	Concurrency  int
	MaxAttempts  int64
	ClaimAfter   time.Duration
	DrainAfter   time.Duration
	HeartbeatTTL time.Duration
	Reap         func(context.Context) error
}

// New creates a worker runner.
func New(client *redis.Client, executor sandbox.Executor, registry *languages.Registry, options Options) *Runner {
	if options.Group == "" {
		options.Group = defaultGroup
	}
	if options.Concurrency <= 0 {
		options.Concurrency = 1
	}
	if options.MaxAttempts <= 0 {
		options.MaxAttempts = defaultMaxAttempts
	}
	if options.ClaimAfter <= 0 {
		options.ClaimAfter = 35 * time.Second
	}
	if options.DrainAfter <= 0 {
		options.DrainAfter = 30 * time.Second
	}
	if options.HeartbeatTTL <= 0 {
		options.HeartbeatTTL = 30 * time.Second
	}
	return &Runner{
		client:       client,
		consumer:     queue.NewConsumer(client, options.Group, options.ConsumerName, options.MaxAttempts),
		executor:     executor,
		registry:     registry,
		concurrency:  options.Concurrency,
		claimAfter:   options.ClaimAfter,
		drainAfter:   options.DrainAfter,
		heartbeatTTL: options.HeartbeatTTL,
		reap:         options.Reap,
	}
}

// Run serves jobs until ctx is cancelled, then drains in-flight jobs up to its deadline.
func (r *Runner) Run(ctx context.Context) error {
	if err := r.consumer.EnsureGroup(ctx); err != nil {
		return err
	}

	sem := make(chan struct{}, r.concurrency)
	var jobs sync.WaitGroup
	reclaimTicker := time.NewTicker(r.claimAfter / 2)
	heartbeatTicker := time.NewTicker(r.heartbeatTTL / 2)
	reaperTicker := time.NewTicker(time.Minute)
	defer reclaimTicker.Stop()
	defer heartbeatTicker.Stop()
	defer reaperTicker.Stop()

	r.writeHeartbeat(context.Background())
	for {
		select {
		case <-ctx.Done():
			return r.drain(&jobs)
		case <-heartbeatTicker.C:
			r.writeHeartbeat(context.Background())
		case <-reaperTicker.C:
			if r.reap != nil {
				_ = r.reap(context.Background())
			}
		case <-reclaimTicker.C:
			messages, err := r.consumer.ClaimIdle(ctx, r.claimAfter)
			if err != nil {
				continue
			}
			r.startAll(ctx, sem, &jobs, messages)
		default:
			messages, err := r.consumer.Read(ctx, 500*time.Millisecond)
			if err != nil {
				if ctx.Err() != nil {
					return r.drain(&jobs)
				}
				continue
			}
			r.startAll(ctx, sem, &jobs, messages)
		}
	}
}

func (r *Runner) startAll(ctx context.Context, sem chan struct{}, jobs *sync.WaitGroup, messages []queue.Message) {
	for _, message := range messages {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			return
		}
		jobs.Add(1)
		go func(message queue.Message) {
			defer func() { <-sem; jobs.Done() }()
			_ = r.process(message)
		}(message)
	}
}

func (r *Runner) process(message queue.Message) error {
	ctx := context.Background()
	if r.consumer.ShouldDeadLetter(message) {
		return r.consumer.DeadLetter(ctx, message, "maximum delivery attempts exceeded")
	}
	terminal, err := queue.IsTerminal(ctx, r.client, message.Job.ID)
	if err != nil {
		return err
	}
	if terminal {
		return r.consumer.Ack(ctx, message.ID)
	}

	lockTTL := time.Duration(message.Job.Limits.TimeoutMS)*time.Millisecond + defaultGrace
	if lockTTL < 15*time.Second {
		lockTTL = 15 * time.Second
	}
	locked, err := queue.AcquireProcessing(ctx, r.client, message.Job.ID, r.consumerName(), lockTTL)
	if err != nil || !locked {
		return err // leave the message pending for a later reclaim if another worker owns it.
	}

	language, err := r.registry.Get(message.Job.Language)
	if err != nil {
		return r.complete(ctx, message, &sandbox.ExecutionResult{Status: sandbox.StatusInternalError, ErrorMessage: err.Error()})
	}

	r.active.Add(1)
	defer r.active.Add(-1)
	execCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopCancelWatch := r.watchCancellation(execCtx, cancel, message.Job.ID)
	defer stopCancelWatch()

	result, err := r.executor.Run(execCtx, sandbox.ExecutionSpec{
		JobID: message.Job.ID, Language: language, SourceCode: message.Job.SourceCode,
		Stdin: message.Job.Stdin, Args: message.Job.Args, Limits: message.Job.Limits,
		EventSink: events.NewRedisSink(r.client),
	})
	if err != nil {
		return err
	}
	return r.complete(ctx, message, result)
}

func (r *Runner) complete(ctx context.Context, message queue.Message, result *sandbox.ExecutionResult) error {
	if err := queue.MarkTerminal(ctx, r.client, message.Job.ID, result); err != nil {
		return fmt.Errorf("record terminal result: %w", err)
	}
	return r.consumer.Ack(ctx, message.ID)
}

func (r *Runner) watchCancellation(ctx context.Context, cancel context.CancelFunc, jobID string) func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				cancelled, err := queue.IsCancelled(context.Background(), r.client, jobID)
				if err == nil && cancelled {
					cancel()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() { close(done) }
}

func (r *Runner) drain(jobs *sync.WaitGroup) error {
	done := make(chan struct{})
	go func() { jobs.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-time.After(r.drainAfter):
		return fmt.Errorf("worker drain deadline exceeded after %s", r.drainAfter)
	}
}

func (r *Runner) writeHeartbeat(ctx context.Context) {
	payload, err := json.Marshal(map[string]any{"capacity": r.concurrency, "active": r.active.Load()})
	if err == nil {
		_ = r.client.Set(ctx, fmt.Sprintf("kairo:worker:%s:heartbeat", r.consumerName()), payload, r.heartbeatTTL).Err()
	}
}

func (r *Runner) consumerName() string {
	return r.consumer.Name()
}
