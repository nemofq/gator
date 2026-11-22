import { useState } from "preact/hooks";
import { api } from "../api";
import { Alert, useAction } from "../ui";

export function SignIn(props: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e: Event) => {
    e.preventDefault();
    run(() => api("/api/login", "POST", { password }).then(props.onSignedIn));
  };
  return (
    <main class="consent">
      <div class="brand">
        <span class="mark" aria-hidden="true" />
        <span class="word">GATOR</span>
      </div>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label for="password">Owner password</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          required
          value={password}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        {error && <Alert>{error}</Alert>}
        <div class="actions">
          <button type="submit" class="primary" disabled={busy}>
            Sign in
          </button>
        </div>
      </form>
    </main>
  );
}
