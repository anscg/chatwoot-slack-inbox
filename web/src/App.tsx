import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Agents } from "./pages/Agents";
import { Bridges } from "./pages/Bridges";
import { Overview } from "./pages/Overview";
import { People } from "./pages/People";
import { Retries } from "./pages/Retries";
import { Threads } from "./pages/Threads";

const PAGES = [
  ["overview", "Overview", Overview, () => true],
  ["bridges", "Bridges", Bridges, () => true],
  ["people", "People", People, (me: Me) => me.can.managePeople],
  ["agents", "Agents", Agents, () => true],
  ["threads", "Threads", Threads, () => true],
  ["retries", "Retries", Retries, () => true],
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
        <p className="muted">Control panel. Sign in with the Slack account you were given access with.</p>
        <a className="btn" href="/admin/login">
          Sign in with Slack
        </a>
      </div>
    );
  }

  const pages = PAGES.filter(([, , , visible]) => visible(me));
  const Page = pages.find(([k]) => k === route)?.[2] ?? Overview;
  return (
    <div className="shell">
      <header className="top">
        <h1>chatwoot-slack-inbox</h1>
        <nav>
          {pages.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={route === key ? "active" : ""}>
              {label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>
            {me.user.name} <span className="pill">{me.user.role}</span>
          </span>
          <form method="post" action="/admin/logout">
            <button className="small">Sign out</button>
          </form>
        </div>
      </header>
      <Page me={me} />
    </div>
  );
}
