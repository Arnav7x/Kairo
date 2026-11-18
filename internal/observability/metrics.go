package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// JobsTotal counts all completed/failed/timed out sandbox executions by status and language.
	JobsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "kairo_jobs_total",
			Help: "Total count of processed sandbox jobs partitioned by status and language.",
		},
		[]string{"status", "language"},
	)

	// QueueDepth tracks the current number of pending jobs in Redis streams.
	QueueDepth = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "kairo_queue_depth",
			Help: "Current depth of the kairo job stream in Redis.",
		},
	)

	// JobDuration tracks total execution duration from claim to terminal status in seconds.
	JobDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "kairo_job_duration_seconds",
			Help:    "Execution duration of sandbox jobs in seconds.",
			Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0},
		},
		[]string{"language"},
	)

	// ContainerStartDuration tracks cold container creation & startup latency in seconds.
	ContainerStartDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "kairo_container_start_seconds",
			Help:    "Time taken to create and start a sandbox container in seconds.",
			Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0},
		},
		[]string{"runtime", "language"},
	)

	// WorkerActiveJobs tracks currently running jobs across the worker instance.
	WorkerActiveJobs = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "kairo_worker_active_jobs",
			Help: "Number of jobs currently executing on this worker instance.",
		},
	)

	// OutputBytesTotal tracks total bytes streamed from stdout/stderr.
	OutputBytesTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "kairo_output_bytes_total",
			Help: "Total bytes emitted by sandbox containers across streams.",
		},
		[]string{"stream", "language"},
	)
)
