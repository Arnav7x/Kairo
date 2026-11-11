import { useCallback, useEffect, useState } from "react";

import { fetchJobs, type JobSummary } from "./api.js";

export function HistoryPage({ onOpen }: { onOpen: (jobId: string) => void }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJobs(25);
      setJobs(response.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="history">
      <div className="toolbar">
        <h2>Run history</h2>
        <div className="spacer" />
        <button className="button" onClick={() => void load()} disabled={loading}>
          ⟳ Refresh
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && !jobs.length ? (
        <p className="empty">Loading runs…</p>
      ) : jobs.length === 0 ? (
        <p className="empty">No runs yet. Submit a job from the editor.</p>
      ) : (
        <table className="jobs-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Language</th>
              <th>Status</th>
              <th>Exit</th>
              <th>Duration</th>
              <th>Memory peak</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} onClick={() => onOpen(job.id)}>
                <td className="mono">{job.id.slice(0, 8)}</td>
                <td>{job.language}</td>
                <td>
                  <span className={`pill ${statusClass(job.status)}`}>{job.status.replace(/_/g, " ")}</span>
                </td>
                <td>{job.exit_code ?? "—"}</td>
                <td>{job.duration_ms !== null ? `${(job.duration_ms / 1000).toFixed(2)} s` : "—"}</td>
                <td>{job.peak_memory_bytes !== null ? `${(job.peak_memory_bytes / 1024 / 1024).toFixed(1)} MB` : "—"}</td>
                <td>{new Date(job.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "queued":
    case "running":
      return "queued";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}
