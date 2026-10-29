package sandbox

import (
	"bytes"
	"context"
	"sync"
	"time"

	"github.com/Arnav7x/kairo/internal/events"
)

const (
	maxEventFrameSize = 4 * 1024
	flushInterval     = 50 * time.Millisecond
)

// outputCollector buffers final output and emits bounded live output frames.
type outputCollector struct {
	ctx       context.Context
	jobID     string
	phase     string
	maxOutput int64
	sink      events.Sink
	limitCh   chan<- struct{}

	mu       sync.Mutex
	stdout   bytes.Buffer
	stderr   bytes.Buffer
	frames   map[events.Stream]*bytes.Buffer
	limited  bool
	stopTick chan struct{}
	doneTick chan struct{}
}

func newOutputCollector(ctx context.Context, jobID string, phase string, maxOutput int64, sink events.Sink, limitCh chan<- struct{}) *outputCollector {
	c := &outputCollector{
		ctx:       ctx,
		jobID:     jobID,
		phase:     phase,
		maxOutput: maxOutput,
		sink:      sink,
		limitCh:   limitCh,
		frames: map[events.Stream]*bytes.Buffer{
			events.StreamStdout: {},
			events.StreamStderr: {},
		},
		stopTick: make(chan struct{}),
		doneTick: make(chan struct{}),
	}
	go c.flushOnInterval()
	return c
}

func (c *outputCollector) writer(stream events.Stream) *streamWriter {
	return &streamWriter{collector: c, stream: stream}
}

func (c *outputCollector) write(stream events.Stream, data []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.limited {
		return len(data), nil
	}

	var destination *bytes.Buffer
	if stream == events.StreamStdout {
		destination = &c.stdout
	} else {
		destination = &c.stderr
	}

	remaining := c.maxOutput - int64(c.stdout.Len()+c.stderr.Len())
	accepted := data
	if int64(len(accepted)) > remaining {
		accepted = accepted[:int(remaining)]
		c.limited = true
	}
	destination.Write(accepted)
	c.appendFramesLocked(stream, accepted)
	if c.limited {
		c.flushLocked(stream)
		select {
		case c.limitCh <- struct{}{}:
		default:
		}
	}
	return len(data), nil
}

func (c *outputCollector) appendFramesLocked(stream events.Stream, data []byte) {
	frame := c.frames[stream]
	for len(data) > 0 {
		space := maxEventFrameSize - frame.Len()
		n := len(data)
		if n > space {
			n = space
		}
		if newline := bytes.IndexByte(data[:n], '\n'); newline >= 0 {
			n = newline + 1
		}
		part := data[:n]
		frame.Write(part)
		data = data[n:]
		if part[len(part)-1] == '\n' || frame.Len() == maxEventFrameSize {
			c.flushLocked(stream)
		}
	}
}

func (c *outputCollector) flushOnInterval() {
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	defer close(c.doneTick)
	for {
		select {
		case <-ticker.C:
			c.mu.Lock()
			c.flushLocked(events.StreamStdout)
			c.flushLocked(events.StreamStderr)
			c.mu.Unlock()
		case <-c.stopTick:
			return
		}
	}
}

func (c *outputCollector) flushLocked(stream events.Stream) {
	frame := c.frames[stream]
	if frame.Len() == 0 {
		return
	}
	data := frame.String()
	frame.Reset()
	if c.sink == nil {
		return
	}
	// A sink failure must not block or alter the sandbox lifecycle. The stream
	// remains the source of truth for execution status and cleanup.
	_ = c.sink.Publish(c.ctx, events.Event{JobID: c.jobID, Phase: c.phase, Stream: stream, Data: data, Timestamp: time.Now().UTC()})
}

func (c *outputCollector) close() (stdout, stderr string, limited bool) {
	close(c.stopTick)
	<-c.doneTick
	c.mu.Lock()
	defer c.mu.Unlock()
	c.flushLocked(events.StreamStdout)
	c.flushLocked(events.StreamStderr)
	return c.stdout.String(), c.stderr.String(), c.limited
}

type streamWriter struct {
	collector *outputCollector
	stream    events.Stream
}

func (w *streamWriter) Write(data []byte) (int, error) {
	return w.collector.write(w.stream, data)
}
