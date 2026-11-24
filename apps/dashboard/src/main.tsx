import { type JSX, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import "../public/authorize.css";
import "./app.css";
import { api, type Session, signOut, startSession } from "./api";
import { Agents } from "./pages/agents";
import { NewProvider } from "./pages/new-provider";
import { Overview } from "./pages/overview";
import { ProviderPage } from "./pages/provider";
import { Providers } from "./pages/providers";
import { SettingsPage } from "./pages/settings";
import { SignIn } from "./pages/sign-in";
import { Button, Icon, navigate, ProviderLinks, REPO, Segmented, useAction } from "./ui";

const NAV = [
  ["/", "Overview"],
  ["/providers", "Providers"],
  ["/agents", "Agents"],
  ["/settings", "Settings"],
] as const;

const active = (path: string, href: string) =>
  href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);

function route(path: string, session: Session, refreshSession: () => void) {
  if (path === "/") return <Overview />;
  if (path === "/agents") return <Agents mcpUrl={session.mcp_url} />;
  if (path === "/providers") return <Providers />;
  if (path === "/providers/new") return <NewProvider />;
  if (path.startsWith("/providers/"))
    return (
      <ProviderPage
        key={path}
        id={decodeURIComponent(path.slice(11))}
        refreshSession={refreshSession}
      />
    );
  if (path === "/settings") return <SettingsPage session={session} />;
  return (
    <>
      <h1 class="display">Not found</h1>
      <p class="lead">Nothing here. Pick a page above.</p>
    </>
  );
}

// Same-origin links navigate without a reload.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a");
  const href = a?.getAttribute("href");
  if (!href?.startsWith("/") || a?.target || e.button || e.metaKey || e.ctrlKey || e.shiftKey)
    return;
  e.preventDefault();
  if (href !== location.pathname) navigate(href);
});

const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const ICONS: Record<Theme, JSX.Element> = {
  auto: (
    <path d="M8 1.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5zm0 1.5a5.25 5.25 0 1 1 0 10.5 5.25 5.25 0 0 1 0-10.5zM8 4a4 4 0 0 1 0 8z" />
  ),
  light: (
    <path d="M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM7.25 0h1.5v2.5h-1.5zm0 13.5h1.5V16h-1.5zM0 7.25h2.5v1.5H0zm13.5 0H16v1.5h-2.5zM2.1 3.16l1.06-1.06 1.77 1.77-1.06 1.06zm8.97 8.97 1.06-1.06 1.77 1.77-1.06 1.06zM2.1 12.84l1.77-1.77 1.06 1.06-1.77 1.77zm8.97-8.97 1.77-1.77 1.06 1.06-1.77 1.77z" />
  ),
  dark: <path d="M6.2 1.2A6.9 6.9 0 1 0 14.8 9.8 5.6 5.6 0 0 1 6.2 1.2z" />,
};

/** Three buttons where there is room; on narrow screens one button that steps through them. */
function ThemeControl() {
  const read = (): Theme => {
    try {
      return (localStorage.getItem("gator-theme") as Theme | null) ?? "auto";
    } catch {
      return "auto";
    }
  };
  const [theme, setTheme] = useState(read);
  const choose = (t: Theme) => {
    try {
      if (t === "auto") localStorage.removeItem("gator-theme");
      else localStorage.setItem("gator-theme", t);
    } catch {}
    dispatchEvent(new Event("gator-theme"));
    setTheme(t);
  };
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return (
    <>
      <Segmented
        legend="Theme"
        options={THEMES.map((t) => ({ value: t, text: t }))}
        value={theme}
        onChange={choose}
      />
      <button
        type="button"
        class="theme-step"
        aria-label={`Theme: ${theme}. Switch to ${next}`}
        title={`Theme: ${theme}`}
        onClick={() => choose(next)}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
        >
          {ICONS[theme]}
        </svg>
      </button>
    </>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>();
  const [fatal, setFatal] = useState("");
  const [path, setPath] = useState(location.pathname);
  const main = useRef<HTMLElement>(null);
  const out = useAction();

  const loadSession = () =>
    api<Session>("/api/session").then(
      (s) => {
        startSession(s);
        setSession(s);
        setFatal("");
      },
      (e: Error) => setFatal(e.message),
    );
  useEffect(() => {
    addEventListener("gator-signed-out", () => setSession(null));
    addEventListener("popstate", () => {
      setPath(location.pathname);
      scrollTo(0, 0);
      main.current?.focus();
    });
    loadSession();
  }, []);

  const label = NAV.find(([href]) => active(path, href))?.[1];
  useEffect(() => {
    document.title = label ? `${label} · Gator` : "Gator";
  }, [label]);

  if (session === null) return <SignIn onSignedIn={loadSession} />;
  if (!session) return fatal ? <p class="fatal">{fatal}</p> : null;

  const unreadable = session.keys_unreadable;

  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="top">
        <a class="brand" href="/" aria-label="Gator overview">
          <span class="mark" aria-hidden="true" />
          <span class="word">GATOR</span>
        </a>
        <nav aria-label="Main">
          {NAV.map(([href, text]) => (
            <a key={href} href={href} aria-current={active(path, href) ? "page" : undefined}>
              <span>{text}</span>
            </a>
          ))}
        </nav>
        <a
          class="repo"
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          title="Gator on GitHub"
        >
          <span class="sr-only">Gator on GitHub</span>
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
          </svg>
        </a>
        <ThemeControl />
        <Button action={out} class="signout" onRun={signOut}>
          Sign out
        </Button>
      </header>
      {unreadable.length > 0 && (
        <div class="banner" role="alert">
          <strong>
            <Icon name="error" />
            Keys need re-entering.
          </strong>{" "}
          Gator cannot read the keys for <ProviderLinks providers={unreadable} />: the encryption
          key has changed. Enter them again, or put the previous <code>MASTER_KEY</code> back.
        </div>
      )}
      <main id="main" ref={main} tabIndex={-1}>
        {route(path, session, loadSession)}
      </main>
    </>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
