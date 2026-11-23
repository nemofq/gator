import { useState } from "preact/hooks";
import { api } from "../api";
import { Alert, Button, useAction } from "../ui";

export function SignIn(props: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const action = useAction();
  const submit = (e: Event) => {
    e.preventDefault();
    action.run(() => api("/api/login", "POST", { password }).then(props.onSignedIn));
  };
  return (
    <main class="consent">
      <div class="brand">
        <span class="mark" aria-hidden="true" />
        <span class="word">GATOR</span>
      </div>
      <form onSubmit={submit} aria-label="Sign in">
        <label for="password">Owner password</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          required
          value={password}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        {action.error && <Alert>{action.error}</Alert>}
        <div class="actions">
          <Button action={action} class="primary">
            Sign in
          </Button>
        </div>
      </form>
    </main>
  );
}
