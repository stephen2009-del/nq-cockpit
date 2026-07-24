"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      const from = params.get("from") || "/";
      router.push(from);
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Login failed.");
      setLoading(false);
    }
  }

  return (
    <div className="wrap" style={{ maxWidth: 380, paddingTop: "20vh" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div className="brand" style={{ fontSize: 28, fontWeight: 700 }}>
          NQ <span>COCKPIT</span>
        </div>
        <div className="card-sub" style={{ marginTop: 4 }}>Discipline Instrumentation // Personal Trading Log</div>
      </div>
      <div className="panel-box">
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <div className="card-sub" style={{ color: "var(--red)", marginBottom: 12 }}>⚠ {error}</div>}
          <button className="btn primary" type="submit" disabled={loading} style={{ width: "100%" }}>
            {loading ? "Logging in…" : "Log In"}
          </button>
        </form>
      </div>
    </div>
  );
}

// useSearchParams needs a Suspense boundary in the App Router, or the page
// fails to build.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
