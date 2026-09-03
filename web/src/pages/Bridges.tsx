import { useEffect, useState, type FormEvent } from "react";
import { api, type Bridge, type Introspection, type Me, type SlackIntrospection } from "../api";
import { Copy, useResource } from "./common";

interface Draft {
  name: string;
  slug: string;
  slackChannel: string;
  slackBotToken: string;
  slackSigningSecret: string;
  chatwootAccountId: string;
  chatwootInboxIdentifier: string;
  chatwootApiToken: string;
  reactionResolve: string;
  reactionAssign: string;
  welcomeMessage: string;
  resolveMessage: string;
  reopenMessage: string;
  enabled: boolean;
}

const EMPTY: Draft = {
  name: "",
  slug: "",
  slackChannel: "",
  slackBotToken: "",
  slackSigningSecret: "",
  chatwootAccountId: "",
  chatwootInboxIdentifier: "",
  chatwootApiToken: "",
  reactionResolve: "white_check_mark",
  reactionAssign: "eyes",
  welcomeMessage: "",
  resolveMessage: "",
  reopenMessage: "",
  enabled: true,
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

function fromBridge(b: Bridge): Draft {
  return {
    ...EMPTY,
    name: b.name,
    slug: b.slug,
    slackChannel: b.slackChannel,
    chatwootAccountId: String(b.chatwootAccountId),
    chatwootInboxIdentifier: b.chatwootInboxIdentifier,
    reactionResolve: b.reactionResolve ?? "",
    reactionAssign: b.reactionAssign ?? "",
    welcomeMessage: b.welcomeMessage ?? "",
    resolveMessage: b.resolveMessage ?? "",
    reopenMessage: b.reopenMessage ?? "",
    enabled: b.enabled,
  };
}

export function Bridges({ me }: { me: Me }) {
  const { data, error, reload } = useResource<Bridge[]>("/bridges");
  const [editing, setEditing] = useState<Bridge | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Bridges</h2>
          <button className="primary" onClick={() => setEditing("new")}>
            New bridge
          </button>
        </div>
        <p className="note">Each bridge is one Slack channel, one Slack app (its own bot), and one Chatwoot API inbox in some account.</p>
        {error && <p className="err">{error}</p>}
        {notice && <p className="err">{notice}</p>}
        {data && data.length === 0 && <p className="muted">No bridges yet.</p>}
        {data && data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slack</th>
                <th>Chatwoot</th>
                <th>Reactions</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                    <div className="note mono">{b.slug}</div>
                  </td>
                  <td>
                    channel <code>{b.slackChannel}</code>
                    <br />
                    <span className="muted">bot </span>
                    <code>{b.slackBotUserId ?? "?"}</code>
                  </td>
                  <td>
                    account <code>{b.chatwootAccountId}</code>
                    <br />
                    <span className="muted mono">{b.chatwootInboxIdentifier}</span>
                  </td>
                  <td>
                    resolve: {b.reactionResolve ? <code>:{b.reactionResolve}:</code> : <span className="pill off">off</span>}
                    <br />
                    assign: {b.reactionAssign ? <code>:{b.reactionAssign}:</code> : <span className="pill off">off</span>}
                  </td>
                  <td>{b.enabled ? <span className="pill ok">enabled</span> : <span className="pill off">disabled</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="small" onClick={() => setEditing(b)}>
                      Edit
                    </button>{" "}
                    <button
                      className="small danger"
                      onClick={async () => {
                        if (!confirm(`Delete bridge "${b.name}"? Existing thread mappings stay in the database.`)) return;
                        await api.del(`/bridges/${b.id}`);
                        reload();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <BridgeForm
          me={me}
          bridge={editing === "new" ? null : editing}
          onDone={(warning) => {
            setEditing(null);
            setNotice(warning ?? null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

function BridgeForm({ me, bridge, onDone, onCancel }: { me: Me; bridge: Bridge | null; onDone: (warning?: string) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(bridge ? fromBridge(bridge) : { ...EMPTY, ...me.defaults });
  const [slugTouched, setSlugTouched] = useState(Boolean(bridge));
  const [cw, setCw] = useState<Introspection | null>(null);
  const [cwErr, setCwErr] = useState<string | null>(null);
  const [sl, setSl] = useState<SlackIntrospection | null>(null);
  const [slErr, setSlErr] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));

  // Slug follows the name until edited by hand.
  useEffect(() => {
    if (!slugTouched) setD((x) => ({ ...x, slug: slugify(x.name) }));
  }, [d.name, slugTouched]);

  // Manifest preview for the Slack app.
  useEffect(() => {
    if (!d.slug) return void setManifest("");
    const q = new URLSearchParams({ name: d.name || "Support Bridge", slug: d.slug });
    fetch(`/admin/api/manifest?${q}`, { credentials: "same-origin" })
      .then((r) => r.text())
      .then(setManifest)
      .catch(() => setManifest(""));
  }, [d.name, d.slug]);

  // Chatwoot token -> accounts + inboxes.
  useEffect(() => {
    if (d.chatwootApiToken.length < 10) return;
    const t = setTimeout(() => {
      api
        .post<Introspection>("/chatwoot/introspect", { apiToken: d.chatwootApiToken })
        .then((r) => (setCw(r), setCwErr(null)))
        .catch((e) => (setCw(null), setCwErr(e.message)));
    }, 400);
    return () => clearTimeout(t);
  }, [d.chatwootApiToken]);

  // Slack bot token (or the saved one) -> bot identity; plus a check of the typed channel ID.
  useEffect(() => {
    const base = d.slackBotToken.length > 10 ? { botToken: d.slackBotToken } : bridge ? { bridgeId: bridge.id } : null;
    if (!base) return;
    const channelOk = /^[CG][A-Z0-9]{6,}$/.test(d.slackChannel);
    const t = setTimeout(() => {
      api
        .post<SlackIntrospection>("/slack/introspect", { ...base, ...(channelOk ? { channel: d.slackChannel } : {}) })
        .then((r) => (setSl(r), setSlErr(null)))
        .catch((e) => (setSl(null), setSlErr(e.message)));
    }, 400);
    return () => clearTimeout(t);
  }, [d.slackBotToken, d.slackChannel, bridge]);

  const account = cw?.accounts.find((a) => String(a.id) === d.chatwootAccountId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const body = {
      name: d.name,
      slug: d.slug,
      slackChannel: d.slackChannel,
      ...(d.slackBotToken ? { slackBotToken: d.slackBotToken } : {}),
      ...(d.slackSigningSecret ? { slackSigningSecret: d.slackSigningSecret } : {}),
      chatwootAccountId: Number(d.chatwootAccountId),
      chatwootInboxIdentifier: d.chatwootInboxIdentifier,
      ...(d.chatwootApiToken ? { chatwootApiToken: d.chatwootApiToken } : {}),
      reactionResolve: d.reactionResolve,
      reactionAssign: d.reactionAssign,
      welcomeMessage: d.welcomeMessage,
      resolveMessage: d.resolveMessage,
      reopenMessage: d.reopenMessage,
      enabled: d.enabled,
    };
    try {
      const saved = bridge ? await api.put<Bridge>(`/bridges/${bridge.id}`, body) : await api.post<Bridge>("/bridges", body);
      onDone(saved.warning);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>{bridge ? `Edit ${bridge.name}` : "New bridge"}</h2>

      <h3 className="step">1. Name</h3>
      <div className="form-grid">
        <div className="field">
          <label>Name (also the Slack bot's display name)</label>
          <input value={d.name} onChange={set("name")} required placeholder="e.g. HCB Support" />
        </div>
        <div className="field">
          <label>Slug (in the Slack event URL; don't change after creating the app)</label>
          <input
            value={d.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug")(e);
            }}
            required
            pattern="[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?"
            placeholder="hcb-support"
          />
        </div>
      </div>

      <h3 className="step">2. Slack app</h3>
      <p className="note">
        At <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps</a> choose <em>Create New App → From a manifest</em>, paste this, install it to the
        workspace, then invite the bot to the channel. Slack will verify the Request URL against this server on save.
      </p>
      {manifest && (
        <div className="field">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label style={{ margin: 0 }}>Manifest</label>
            <span className="row">
              <a className="btn small" href={`/admin/api/manifest?${new URLSearchParams({ name: d.name || "Support Bridge", slug: d.slug, download: "1" })}`} download>
                Download
              </a>
              <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(manifest)}>
                Copy
              </button>
            </span>
          </div>
          <pre className="manifest">{manifest}</pre>
        </div>
      )}
      <div className="form-grid">
        <div className="field">
          <label>Bot User OAuth Token {bridge && <span>(blank keeps current)</span>}</label>
          <input value={d.slackBotToken} onChange={set("slackBotToken")} placeholder={bridge?.hasSlackApp ? "xoxb-•••••" : "xoxb-…  (OAuth & Permissions)"} required={!bridge} autoComplete="off" />
          {slErr && <p className="err">{slErr}</p>}
          {sl && (
            <p className="note">
              Bot <strong>@{sl.bot.name}</strong> (<code>{sl.bot.userId}</code>) in {sl.bot.team}.
            </p>
          )}
        </div>
        <div className="field">
          <label>Signing Secret {bridge && <span>(blank keeps current)</span>}</label>
          <input value={d.slackSigningSecret} onChange={set("slackSigningSecret")} placeholder={bridge ? "••••••••" : "Basic Information → App Credentials"} required={!bridge} autoComplete="off" />
        </div>
        <div className="field">
          <label>Slack channel ID</label>
          <input value={d.slackChannel} onChange={set("slackChannel")} required pattern="[CG][A-Z0-9]+" placeholder="C0123456789" />
          <p className="note">Channel details → scroll to the bottom of the About tab.</p>
          {sl?.channel &&
            (sl.channel.error ? (
              <p className="err">Bot can't see this channel ({sl.channel.error}). Invite it: /invite @{sl.bot.name}</p>
            ) : sl.channel.isMember ? (
              <p className="note">
                #{sl.channel.name} — <span className="pill ok">bot is a member</span>
              </p>
            ) : (
              <p className="note">
                #{sl.channel.name} — <span className="pill warn">bot not a member yet</span>; run /invite @{sl.bot.name} there.
              </p>
            ))}
        </div>
      </div>

      <h3 className="step">3. Chatwoot</h3>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Service-agent access token {bridge && <span>(blank keeps current)</span>}</label>
          <input value={d.chatwootApiToken} onChange={set("chatwootApiToken")} placeholder={bridge?.hasChatwootToken ? "••••••••" : "Chatwoot: Profile settings → Access token"} required={!bridge} autoComplete="off" />
          {cwErr && <p className="err">{cwErr}</p>}
          {cw && (
            <p className="note">
              Token belongs to <strong>{cw.profile.name}</strong> ({cw.profile.email}). Slack replies from non-linked agents will be attributed to this user.
            </p>
          )}
        </div>
        <div className="field">
          <label>Account</label>
          {cw ? (
            <select value={d.chatwootAccountId} onChange={set("chatwootAccountId")} required>
              <option value="">Select…</option>
              {cw.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (#{a.id})
                </option>
              ))}
            </select>
          ) : (
            <input value={d.chatwootAccountId} onChange={set("chatwootAccountId")} required inputMode="numeric" placeholder="Account ID" />
          )}
        </div>
        <div className="field">
          <label>API inbox</label>
          {account ? (
            <select value={d.chatwootInboxIdentifier} onChange={set("chatwootInboxIdentifier")} required>
              <option value="">Select…</option>
              {account.inboxes.map((i) => (
                <option key={i.id} value={i.inboxIdentifier ?? ""}>
                  {i.name}
                </option>
              ))}
              {account.inboxes.length === 0 && <option disabled>No API inboxes in this account</option>}
            </select>
          ) : (
            <input value={d.chatwootInboxIdentifier} onChange={set("chatwootInboxIdentifier")} required placeholder="Inbox identifier" />
          )}
        </div>
      </div>

      <h3 className="step">4. Behaviour</h3>
      <div className="form-grid">
        <div className="field">
          <label>Resolve reaction (emoji name, blank = off)</label>
          <input value={d.reactionResolve} onChange={set("reactionResolve")} placeholder="white_check_mark" />
        </div>
        <div className="field">
          <label>Assign reaction (emoji name, blank = off)</label>
          <input value={d.reactionAssign} onChange={set("reactionAssign")} placeholder="eyes" />
        </div>
        <div className="field">
          <label>
            <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={d.enabled} onChange={(e) => setD((x) => ({ ...x, enabled: e.target.checked }))} />
            Enabled
          </label>
        </div>
      </div>
      <p className="note">Messages the bot posts in the Slack thread. Slack formatting and :emoji: names work. Blank disables a message.</p>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Welcome message (new thread)</label>
          <textarea rows={2} value={d.welcomeMessage} onChange={set("welcomeMessage")} />
        </div>
        <div className="field">
          <label>Resolved message (requires the conversation_status_changed webhook event)</label>
          <textarea rows={2} value={d.resolveMessage} onChange={set("resolveMessage")} />
        </div>
        <div className="field">
          <label>Reopened message (replaces the resolved message)</label>
          <textarea rows={2} value={d.reopenMessage} onChange={set("reopenMessage")} />
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      <div className="row">
        <button className="primary" disabled={busy}>
          {bridge ? "Save" : "Create"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
