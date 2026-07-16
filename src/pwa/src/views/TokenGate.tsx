import { useState } from "preact/hooks";
import { api, setToken } from "../api";

export function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      // Validate against /status before persisting.
      await api("/status", { token });
      setToken(token);
      onDone();
    } catch (err) {
      setError(
        err instanceof Error && err.message === "Unauthorized"
          ? "Invalid token"
          : `Could not reach server: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="token-gate">
      <div class="token-card">
        <img src="/icons/icon.svg" alt="" class="token-logo" />
        <h1>Donkai</h1>
        <p class="muted">Enter your API token to connect.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="API token"
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
          />
          <button type="submit" class="btn btn-primary btn-block" disabled={busy || !value.trim()}>
            {busy ? "Checking…" : "Connect"}
          </button>
        </form>
        {error && <p class="error-text">{error}</p>}
      </div>
    </div>
  );
}
