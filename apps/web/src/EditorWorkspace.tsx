import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

import {
  cancelJob,
  fetchJob,
  submitJob,
  type JobRecord,
  type LanguageInfo,
  type OutputEvent,
  type ResultEvent,
} from "./api.js";
import { JobStream, formatBytes, formatMs, type StreamState } from "./stream.js";
import { COLOR, TerminalPanel, type Term } from "./TerminalPanel.js";
import { labelFor, monacoFor, STARTERS, LANGUAGE_ORDER } from "./templates.js";

type RunStatus = "idle" | "queued" | "running" | "finished";

interface TerminalMeta {
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  peakMemoryBytes: number | null;
  errorMessage: string | null;
}

const LAST_JOB_KEY = "kairo:last-job";
const SOURCES_KEY = "kairo:sources";
const WORKSPACE_KEY = "kairo:workspace";

const STATUS_STYLE: Record<string, string> = {
  idle: "pill idle",
  queued: "pill queued",
  connecting: "pill queued",
  reconnecting: "pill queued",
  running: "pill running",
  completed: "pill completed",
  failed: "pill failed",
  timeout: "pill failed",
  oom_killed: "pill failed",
  output_limit: "pill failed",
  internal_error: "pill failed",
  cancelled: "pill cancelled",
};

function statusLabel(status: string | null): string {
  if (!status) return "idle";
  return status.replace(/_/g, " ");
}

function isFatalStatus(status: string): boolean {
  return ["failed", "timeout", "oom_killed", "output_limit", "internal_error"].includes(status);
}

function readSources(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    // ignore malformed cache
  }
  return {};
}

function readWorkspace(): { language?: string; sources?: Record<string, string>; stdin?: string } {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (raw) return JSON.parse(raw) as { language?: string; sources?: Record<string, string>; stdin?: string };
  } catch {
    // ignore malformed cache
  }
  return {};
}

function defaultSource(lang: string, override?: Record<string, string>): string {
  if (override?.[lang]) return override[lang];
  return STARTERS[lang]?.source ?? `Hello from ${labelFor(lang)}`;
}

export function readLastJobId(): string | null {
  return localStorage.getItem(LAST_JOB_KEY);
}

interface EditorWorkspaceProps {
  languages: LanguageInfo[];
  openJobId?: string | null;
}

export function EditorWorkspace({ languages, openJobId }: EditorWorkspaceProps) {
  const orderedLanguages = useMemo(() => {
    const present = new Set(languages.map((l) => l.id));
    const ordered = [...LANGUAGE_ORDER.filter((id) => present.has(id))];
    const orderedSet = new Set(ordered);
    return [...ordered, ...languages.map((l) => l.id).filter((id) => !orderedSet.has(id))];
  }, [languages]);

  const workspace = useRef(readWorkspace());
  const [language, setLanguage] = useState<string>(() => workspace.current.language ?? orderedLanguages[0] ?? "python");
  const [source, setSource] = useState<string>(() => defaultSource(language, workspace.current.sources ?? readSources()));
  const [stdin, setStdin] = useState<string>(() => workspace.current.stdin ?? "");
  const [showStdin, setShowStdin] = useState(false);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [terminalMeta, setTerminalMeta] = useState<TerminalMeta | null>(null);
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [runningMs, setRunningMs] = useState(0);
  const [apiError, setApiError] = useState<string | null>(null);

  const termRef = useRef<Term | null>(null);
  const streamRef = useRef<JobStream | null>(null);
  const sawOutputRef = useRef(false);
  const startedAtRef = useRef<number>(0);
  const activeJobRef = useRef<string | null>(null);
  const phaseRef = useRef<string>("");

  const persistWorkspace = useCallback(() => {
    try {
      localStorage.setItem(
        WORKSPACE_KEY,
        JSON.stringify({
          language,
          sources: { ...readSources(), [language]: source },
          stdin,
        }),
      );
    } catch {
      // storage may be unavailable
    }
  }, [language, source, stdin]);

  const attach = useCallback(
    (id: string) => {
      activeJobRef.current = id;
      setJobId(id);
      localStorage.setItem(LAST_JOB_KEY, id);

      const stream = new JobStream();
      streamRef.current = stream;
      stream.setHandlers({
        onOutput: (event: OutputEvent) => {
          sawOutputRef.current = true;
          if (event.phase && event.phase !== phaseRef.current) {
            phaseRef.current = event.phase;
            termRef.current?.writeNotice(`▐ ${event.phase} ▌\n`);
          }
          if (event.stream === "stderr") {
            termRef.current?.writeStderr(event.data);
          } else {
            termRef.current?.writeStdout(event.data);
          }
        },
        onResult: (event: ResultEvent) => {
          if (!sawOutputRef.current && (event.stdout || event.stderr)) {
            if (event.stdout) termRef.current?.writeStdout(event.stdout);
            if (event.stderr) termRef.current?.writeStderr(event.stderr);
          }
          phaseRef.current = "";
          const status = event.status;
          const color =
            status === "completed" ? COLOR.green : isFatalStatus(status) ? COLOR.red : COLOR.yellow;
          termRef.current?.writeNotice(
            `\n${color}${COLOR.bold}→ ${status} · exit ${event.exit_code} · ${formatMs(event.duration_ms)} · ${formatBytes(event.peak_memory_bytes)}${event.error_message ? ` · ${event.error_message}` : ""}${COLOR.reset}\n`,
          );
          setTerminalMeta({
            status,
            exitCode: event.exit_code,
            durationMs: event.duration_ms,
            peakMemoryBytes: event.peak_memory_bytes,
            errorMessage: event.error_message,
          });
          setRunStatus("finished");
        },
        onState: (state: StreamState) => {
          setStreamState(state);
        },
        onFatal: (reason: string) => {
          termRef.current?.writeError(`✗ ${reason}`);
        },
      });
      setStreamState("connecting");
      stream.open(id);
    },
    [],
  );

  const onTermReady = useCallback(
    (term: Term) => {
      termRef.current = term;
      const attachId = openJobId ?? readLastJobId();
      if (!attachId) return;
      void (async () => {
        let record: JobRecord | null = null;
        try {
          record = await fetchJob(attachId);
        } catch (error) {
          setApiError(error instanceof Error ? error.message : String(error));
          return;
        }
        if (!record) return;

        const terminalAlready = record.status !== "queued" && record.status !== "running";
        if (terminalAlready) {
          term.writeSetupLine(`resumed run ${attachId.slice(0, 8)} · ${labelFor(record.language)}`);
          if (record.stdout) term.writeStdout(record.stdout);
          if (record.stderr) term.writeStderr(record.stderr);
          const color =
            record.status === "completed" ? COLOR.green : isFatalStatus(record.status) ? COLOR.red : COLOR.yellow;
          term.writeNotice(
            `\n${color}${COLOR.bold}→ ${record.status} · exit ${record.exit_code ?? 0} · ${formatMs(record.duration_ms)} · ${formatBytes(record.peak_memory_bytes)}${record.error_message ? ` · ${record.error_message}` : ""}${COLOR.reset}\n`,
          );
          setTerminalMeta({
            status: record.status,
            exitCode: record.exit_code,
            durationMs: record.duration_ms,
            peakMemoryBytes: record.peak_memory_bytes,
            errorMessage: record.error_message,
          });
          setRunStatus("finished");
          setJobId(attachId);
          setStreamState("closed");
          return;
        }

        term.writeSetupLine(`re-attaching to ${attachId.slice(0, 8)} · ${labelFor(record.language)}`);
        startedAtRef.current = record.created_at ? Date.parse(record.created_at) : Date.now();
        setRunningMs(Math.max(0, Date.now() - startedAtRef.current));
        setRunStatus("running");
        attach(attachId);
      })();
    },
    [openJobId, attach],
  );

  useEffect(() => () => streamRef.current?.dispose(), []);

  useEffect(() => {
    persistWorkspace();
  }, [persistWorkspace]);

  useEffect(() => {
    if (runStatus !== "running" && runStatus !== "queued") return;
    const timer = setInterval(() => {
      setRunningMs(Date.now() - startedAtRef.current);
    }, 200);
    return () => clearInterval(timer);
  }, [runStatus]);

  const run = useCallback(async () => {
    setApiError(null);
    const term = termRef.current;
    if (!term) return;
    streamRef.current?.dispose();
    sawOutputRef.current = false;
    phaseRef.current = "";
    setTerminalMeta(null);
    setRunningMs(0);
    setStreamState(null);
    startedAtRef.current = Date.now();
    setRunStatus("queued");
    term.clear();
    term.writeSetupLine(`${labelFor(language)} · submitting run`);

    let id: string;
    try {
      const response = await submitJob({
        language,
        source_code: source,
        stdin: showStdin && stdin ? stdin : undefined,
      });
      id = response.job_id;
    } catch (error) {
      setRunStatus("idle");
      const message = error instanceof Error ? error.message : String(error);
      setApiError(message);
      term.writeError(`✗ submit failed: ${message}`);
      return;
    }

    setRunStatus("running");
    attach(id);
  }, [attach, language, showStdin, source, stdin]);

  const stop = useCallback(async () => {
    const id = activeJobRef.current;
    if (!id) return;
    termRef.current?.writeNotice(`⏹ stop requested for ${id.slice(0, 8)}…\n`);
    try {
      await cancelJob(id);
    } catch (error) {
      termRef.current?.writeError(`✗ stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const changeLanguage = useCallback(
    (next: string) => {
      setLanguage(next);
      setSource(defaultSource(next, readSources()));
    },
    [],
  );

  const displayedStatus = runStatus === "finished" ? terminalMeta?.status ?? "finished" : runStatus;
  const showPill = displayedStatus !== "idle";
  const meta = runStatus === "finished" ? terminalMeta : null;

  return (
    <section className="workspace">
      <div className="toolbar">
        <select
          className="select"
          value={language}
          onChange={(event) => void changeLanguage(event.target.value)}
          disabled={runStatus === "running" || runStatus === "queued"}
        >
          {orderedLanguages.map((id) => {
            const info = languages.find((l) => l.id === id);
            return (
              <option key={id} value={id}>
                {labelFor(id)}
                {info?.compiled ? " (compiled)" : ""}
              </option>
            );
          })}
        </select>
        <div className="spacer" />
        <button
          className="button primary"
          onClick={() => void run()}
          disabled={runStatus === "running" || runStatus === "queued"}
        >
          ▶ Run
        </button>
        <button
          className="button danger"
          onClick={() => void stop()}
          disabled={runStatus !== "running" && runStatus !== "queued"}
        >
          ⏹ Stop
        </button>
      </div>

      {apiError && <div className="error-banner">{apiError}</div>}

      <div className="editor-shell">
        <Editor
          language={monacoFor(language)}
          value={source}
          theme="vs-dark"
          onChange={(value) => setSource(value ?? "")}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 2,
            padding: { top: 10 },
            automaticLayout: true,
          }}
        />
      </div>

      <div className="stdin-row">
        <button type="button" className="link" onClick={() => void setShowStdin((v) => !v)}>
          {showStdin ? "▾" : "▸"} stdin ({stdin ? "has input" : "empty"})
        </button>
        {showStdin && (
          <textarea
            className="stdin-input"
            placeholder="Optional stdin, submitted with the next run…"
            value={stdin}
            onChange={(event) => setStdin(event.target.value)}
          />
        )}
      </div>

      <div className="panel muted">
        {showPill && (
          <span className={STATUS_STYLE[displayedStatus] ?? "pill idle"}>{statusLabel(displayedStatus)}</span>
        )}
        {streamState && streamState !== "closed" && (
          <span className={`pill stream-${streamState}`}>
            {streamState === "live" ? "streaming" : streamState}
          </span>
        )}
        {(runStatus === "running" || runStatus === "queued") && <span className="stat">{formatMs(runningMs)}</span>}
        {runStatus === "finished" && meta && (
          <>
            <span className="stat">exit {meta.exitCode ?? "?"}</span>
            <span className="stat">{formatMs(meta.durationMs)}</span>
            <span className="stat">mem {formatBytes(meta.peakMemoryBytes)}</span>
          </>
        )}
        {runStatus === "idle" && <span className="stat">ready</span>}
      </div>

      <div className="output-shell">
        <TerminalPanel onReady={onTermReady} />
      </div>
    </section>
  );
}
