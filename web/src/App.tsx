import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Agents } from "./pages/Agents";
import { Bridges } from "./pages/Bridges";
import { Overview } from "./pages/Overview";
import { Retries } from "./pages/Retries";
import { Threads } from "./pages/Threads";

const PAGES = [
  ["overview", "Overview", Overview],
  ["bridges", "Bridges", Bridges],
  ["agents", "Agents", Agents],
  ["threads", "Threads", Threads],
  ["retries", "Retries", Retries],
] as const;

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#\/?/, "") || "overview");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.replace(/^#\/?/, "") || "overview");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useHashRoute();

  useEffect(() => {
    api
      .get<Me>("/me")
      .then(setMe)
      .catch((e) => setMe(e instanceof ApiError && e.status === 401 ? null : null));
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) {
    return (
      <div className="center">
        <h1>chatwoot-slack-inbox</h1>
        <p className="muted">Control panel. Sign in with a Slack account listed in <code>ADMIN_SLACK_USER_IDS</code>.</p>
        <a className="btn" href="/admin/login">
          Sign in with Slack
        </a>
      </div>
    );
  }

  const Page = PAGES.find(([k]) => k === route)?.[2] ?? Overview;
  return (
    <div className="shell">
      <header className="top">
        <h1>chatwoot-slack-inbox</h1>
        <nav>
          {PAGES.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={route === key ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>{me.user.name}</span>
          <form method="post" action="/admin/logout">
            <button className="small">Sign out</button>
          </form>
        </div>
      </header>
      <Page me={me} />
    </div>
  );
}
