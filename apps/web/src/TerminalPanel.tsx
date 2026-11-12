import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  defaultFg: "\x1b[39m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
} as const;

export const COLOR = ANSI;

export interface Term {
  clear(): void;
  writeStdout(data: string): void;
  writeStderr(data: string): void;
  writeNotice(data: string): void;
  writeError(message: string): void;
  writeSetupLine(label: string): void;
}

interface TerminalPanelProps {
  onReady: (term: Term) => void;
}

export function TerminalPanel({ onReady }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 8000,
      theme: {
        background: "#0b0e14",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "#33415e",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // container may not be laid out yet
    }
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore transient layout failures
      }
    });
    observer.observe(host);

    const impl: Term = {
      clear() {
        term.reset();
      },
      writeStdout(data: string) {
        term.write(data);
      },
      writeStderr(data: string) {
        term.write(`${ANSI.red}${data}${ANSI.defaultFg}`);
      },
      writeNotice(data: string) {
        term.write(`${ANSI.magenta}${data}${ANSI.defaultFg}`);
      },
      writeError(message: string) {
        term.writeln(`${ANSI.red}${ANSI.bold}${message}${ANSI.reset}`);
      },
      writeSetupLine(label: string) {
        term.writeln(`${ANSI.gray}── ${label} ─────────────────────────${ANSI.reset}`);
      },
    };
    onReady(impl);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [onReady]);

  return <div className="terminal-host" ref={hostRef} />;
}
