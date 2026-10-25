import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Readiness = { ready: boolean; checks: Record<string, string> };

function App() {
  const [health, setHealth] = useState<Readiness | null>(null);

  useEffect(() => {
    void fetch("/readyz")
      .then(async (response) => response.json() as Promise<Readiness>)
      .then(setHealth)
      .catch(() => setHealth({ ready: false, checks: { api: "unreachable" } }));
  }, []);

  return (
    <main>
      <h1>Kairo</h1>
      <p>Remote sandbox execution platform</p>
      <h2>Platform status</h2>
      <p>{health === null ? "Checking…" : health.ready ? "Ready" : "Unavailable"}</p>
      {health && <pre>{JSON.stringify(health.checks, null, 2)}</pre>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
