//go:build integration

package worker_test

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Arnav7x/kairo/internal/languages"
	"github.com/Arnav7x/kairo/internal/queue"
	"github.com/Arnav7x/kairo/internal/sandbox"
	"github.com/Arnav7x/kairo/internal/worker"
	"github.com/redis/go-redis/v9"
)

type countingExecutor struct {
	mu     sync.Mutex
	counts map[string]int
}

func (e *countingExecutor) Run(_ context.Context, spec sandbox.ExecutionSpec) (*sandbox.ExecutionResult, error) {
	e.mu.Lock()
	e.counts[spec.JobID]++
	e.mu.Unlock()
	return &sandbox.ExecutionResult{Status: sandbox.StatusCompleted}, nil
}

func (e *countingExecutor) count(id string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.counts[id]
}

func testRedis(t *testing.T) *redis.Client {
	t.Helper()
	address := os.Getenv("KAIRO_TEST_REDIS_ADDR")
	if address == "" {
		address = "localhost:6379"
	}
	client := redis.NewClient(&redis.Options{Addr: address})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Skipf("Redis is required for integration tests: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestAcceptance_ThreeWorkersCompleteOneHundredJobsExactlyOnce(t *testing.T) {
	client := testRedis(t)
	ctx := context.Background()
	prefix := fmt.Sprintf("phase3-%d", time.Now().UnixNano())
	executor := &countingExecutor{counts: make(map[string]int)}

	producer := queue.NewProducer(client)
	for i := 0; i < 100; i++ {
		if err := producer.Enqueue(ctx, queue.Job{ID: fmt.Sprintf("%s-%03d", prefix, i), Language: "python", SourceCode: "print('ok')"}); err != nil {
			t.Fatalf("enqueue job %d: %v", i, err)
		}
	}

	workers := make([]context.CancelFunc, 0, 3)
	var runnerWG sync.WaitGroup
	for i := 0; i < 3; i++ {
		runner := worker.New(client, executor, languages.NewRegistry(), worker.Options{
			Group: fmt.Sprintf("%s-group", prefix), ConsumerName: fmt.Sprintf("%s-worker-%d", prefix, i), Concurrency: 2,
		})
		runCtx, cancel := context.WithCancel(context.Background())
		workers = append(workers, cancel)
		runnerWG.Add(1)
		go func() {
			defer runnerWG.Done()
			if err := runner.Run(runCtx); err != nil {
				t.Errorf("worker stopped: %v", err)
			}
		}()
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		completed := 0
		for i := 0; i < 100; i++ {
			if executor.count(fmt.Sprintf("%s-%03d", prefix, i)) == 1 {
				completed++
			}
		}
		if completed == 100 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	for i := 0; i < 100; i++ {
		id := fmt.Sprintf("%s-%03d", prefix, i)
		if count := executor.count(id); count != 1 {
			t.Fatalf("job %s executed %d times, want exactly once", id, count)
		}
	}
	for _, cancel := range workers {
		cancel()
	}
	runnerWG.Wait()
}
