import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { fetchLanguages, type LanguageInfo } from "./api.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { HistoryPage } from "./HistoryPage.js";
import "./styles.css";

type Route = { page: "editor" } | { page: "history" } | { page: "job"; id: string };

function parseRoute(): Route {
  const hash = globalThis.location.hash.replace(/^#/, "");
  if (hash === "/history") return { page: "history" };
  const job = hash.match(/^\/jobs\/([\w-]+)$/);
  if (job) return { page: "job", id: job[1] };
  return { page: "editor" };
}

function App() {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void fetchLanguages()
      .then((response) => {
        const wanted = new Set(response.languages.map((l) => l.id));
        const merged = response.languages.map((l) => ({
          ...l,
          name: l.name ?? { python: "Python", cpp: "C++", c: "C", go: "Go", node: "Node.js", rust: "Rust", java: "Java", bash: "Bash" }[l.id] ?? l.id,
        }));
        const extra = ["python", "cpp", "c", "go", "node", "rust", "java", "bash"]
          .filter((id) => !wanted.has(id))
          .map((id) => ({ id }));
        setLanguages([...merged, ...extra]);
      })
      .catch(() => setLanguages(["python", "cpp", "c", "go", "node", "rust", "java", "bash"].map((id) => ({ id }))));
  }, []);

  const nav = (hash: string) => {
    globalThis.location.hash = hash;
    setRoute(parseRoute());
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => nav("/")}>
          kairo <span className="brand-sub">sandbox runner</span>
        </div>
        <nav className="nav">
          <button
            className={`nav-link ${route.page !== "history" ? "active" : ""}`}
            onClick={() => nav("/")}
          >
            Editor
          </button>
          <button
            className={`nav-link ${route.page === "history" ? "active" : ""}`}
            onClick={() => nav("/history")}
          >
            History
          </button>
          <a className="nav-link" href="/history" onClick={(e) => e.preventDefault()} hidden />
        </nav>
        <div className="spacer" />
        <div className="readiness" id="readiness" />
      </header>

      <main className="content">
        {route.page === "history" && <HistoryPage onOpen={(id) => nav(`/jobs/${id}`)} />}
        {route.page !== "history" && (
          <EditorWorkspace key={route.page === "job" ? route.id : "editor"} languages={languages} openJobId={route.page === "job" ? route.id : null} />
        )}
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
