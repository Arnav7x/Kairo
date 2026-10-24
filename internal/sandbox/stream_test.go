package sandbox

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Arnav7x/kairo/internal/events"
)

type fakeSink struct {
	mu     sync.Mutex
	events []events.Event
}

func (s *fakeSink) Publish(_ context.Context, event events.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *fakeSink) snapshot() []events.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]events.Event(nil), s.events...)
}

func TestOutputCollectorEmitsNewlineFrames(t *testing.T) {
	sink := &fakeSink{}
	limitCh := make(chan struct{}, 1)
	collector := newOutputCollector(context.Background(), "job-1", 1024, sink, limitCh)

	if _, err := collector.writer(events.StreamStdout).Write([]byte("first line\nsecond line\n")); err != nil {
		t.Fatalf("write output: %v", err)
	}
	stdout, stderr, limited := collector.close()

	if limited {
		t.Fatal("output unexpectedly reached the cap")
	}
	if stdout != "first line\nsecond line\n" || stderr != "" {
		t.Fatalf("unexpected collected output: stdout=%q stderr=%q", stdout, stderr)
	}
	got := sink.snapshot()
	if len(got) != 2 || got[0].Data != "first line\n" || got[1].Data != "second line\n" {
		t.Fatalf("unexpected events: %#v", got)
	}
	for _, event := range got {
		if event.JobID != "job-1" || event.Stream != events.StreamStdout || event.Timestamp.IsZero() {
			t.Fatalf("invalid event: %#v", event)
		}
	}
}

func TestOutputCollectorFlushesPartialFrameAndEnforcesCap(t *testing.T) {
	sink := &fakeSink{}
	limitCh := make(chan struct{}, 1)
	collector := newOutputCollector(context.Background(), "job-2", 10, sink, limitCh)

	if _, err := collector.writer(events.StreamStderr).Write([]byte("12345678901")); err != nil {
		t.Fatalf("write output: %v", err)
	}
	select {
	case <-limitCh:
	case <-time.After(time.Second):
		t.Fatal("output cap did not signal")
	}
	stdout, stderr, limited := collector.close()

	if !limited || stdout != "" || stderr != "1234567890" {
		t.Fatalf("cap was not enforced: limited=%t stdout=%q stderr=%q", limited, stdout, stderr)
	}
	got := sink.snapshot()
	if len(got) != 1 || got[0].Data != "1234567890" || got[0].Stream != events.StreamStderr {
		t.Fatalf("unexpected capped event: %#v", got)
	}
}
