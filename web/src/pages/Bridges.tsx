import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type Bridge, type BridgeCheck, type BridgeMembers, type BridgeRole, type Introspection, type Me, type SlackIntrospection } from "../api";
import { Copy, fmtDate, useResource } from "./common";

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
  resolvedEmoji: string;
  welcomeMessage: string;
  resolveButtonLabel: string;
  reopenButtonLabel: string;
  resolveMessage: string;
  reopenMessage: string;
  reopenPromptMessage: string;
  followupPromptMessage: string;
  requireLink: boolean;
  linkPromptMessage: string;
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
  resolvedEmoji: "white_check_mark",
  welcomeMessage: "",
  resolveButtonLabel: "",
  reopenButtonLabel: "",
  resolveMessage: "",
  reopenMessage: "",
  reopenPromptMessage: "",
  followupPromptMessage: "",
  requireLink: false,
  linkPromptMessage: "",
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
    resolvedEmoji: b.resolvedEmoji ?? "",
    welcomeMessage: b.welcomeMessage ?? "",
    resolveButtonLabel: b.resolveButtonLabel ?? "",
    reopenButtonLabel: b.reopenButtonLabel ?? "",
    resolveMessage: b.resolveMessage ?? "",
    reopenMessage: b.reopenMessage ?? "",
    reopenPromptMessage: b.reopenPromptMessage ?? "",
    followupPromptMessage: b.followupPromptMessage ?? "",
    requireLink: b.requireLink,
    linkPromptMessage: b.linkPromptMessage ?? "",
    enabled: b.enabled,
  };
}

export function Bridges({ me }: { me: Me }) {
  const { data, error, reload } = useResource<Bridge[]>("/bridges");
  const [editing, setEditing] = useState<Bridge | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [check, setCheck] = useState<BridgeCheck | "loading" | null>(null);
  const [members, setMembers] = useState<Bridge | null>(null);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Bridges</h2>
          {me.can.createBridge && (
            <button className="primary" onClick={() => setEditing("new")}>
              New bridge
            </button>
          )}
        </div>
        <p className="note">
          Each bridge is one Slack channel, one Slack app (its own bot), and one Chatwoot API inbox in some account.{" "}
          {me.user.role === "superadmin"
            ? "You see every bridge on this install."
            : "You see the bridges you run. Whoever creates a bridge is its admin and invites their own operators."}
        </p>
        {error && <p className="err">{error}</p>}
        {notice && <p className="err">{notice}</p>}
        {data && data.length === 0 && (
          <p className="muted">{me.can.createBridge ? "No bridges yet." : "No bridges yet — ask a program's admin to add you to theirs."}</p>
        )}
        {data && data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slack</th>
                <th>Chatwoot</th>
                <th>Reactions</th>
                <th>Status</th>
                <th>You</th>
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
                    stamp: {b.resolvedEmoji ? <code>:{b.resolvedEmoji}:</code> : <span className="pill off">off</span>}
                    <br />
                    resolve: {b.reactionResolve ? <code>:{b.reactionResolve}:</code> : <span className="pill off">off</span>}
                    <br />
                    assign: {b.reactionAssign ? <code>:{b.reactionAssign}:</code> : <span className="pill off">off</span>}
                    <br />
                    button: {b.resolveButtonLabel ? <code>{b.resolveButtonLabel}</code> : <span className="pill off">off</span>} /{" "}
                    {b.reopenButtonLabel ? <code>{b.reopenButtonLabel}</code> : <span className="pill off">off</span>}
                  </td>
                  <td>{b.enabled ? <span className="pill ok">enabled</span> : <span className="pill off">disabled</span>}</td>
                  <td>
                    <span className="pill">{b.yourRole ?? "—"}</span>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      className="small"
                      onClick={async () => {
                        setCheck("loading");
                        try {
                          setCheck(await api.get<BridgeCheck>(`/bridges/${b.id}/check`));
                        } catch (e) {
                          setNotice((e as Error).message);
                          setCheck(null);
                        }
                      }}
                    >
                      Check
                    </button>{" "}
                    <button className="small" onClick={() => setEditing(b)}>
                      Edit
                    </button>{" "}
                    <button className="small" onClick={() => setMembers(b)}>
                      People
                    </button>{" "}
                    {b.yourRole === "admin" && (
                      <button
                        className="small danger"
                        onClick={async () => {
                          if (!confirm(`Delete bridge "${b.name}"? Existing thread mappings stay in the database.`)) return;
                          try {
                            await api.del(`/bridges/${b.id}`);
                            reload();
                          } catch (e) {
                            setNotice((e as Error).message);
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {check && <CheckPanel check={check} onClose={() => setCheck(null)} />}
      {members && <MembersPanel bridge={members} onClose={() => setMembers(null)} />}
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

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail?: ReactNode }) {
  return (
    <tr>
      <td style={{ width: 28 }}>{ok === null ? <span className="muted">–</span> : ok ? <span className="pill ok">ok</span> : <span className="pill warn">!</span>}</td>
      <td style={{ width: 210 }}>{label}</td>
      <td>{detail}</td>
    </tr>
  );
}

function CheckPanel({ check, onClose }: { check: BridgeCheck | "loading"; onClose: () => void }) {
  if (check === "loading") return <div className="panel muted">Checking…</div>;
  const s = check.slack;
  const missing = s?.missingScopes ?? [];
  const b = check.behaviour;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Check: {check.name}</h2>
        <button className="small" onClick={onClose}>
          Close
        </button>
      </div>
      <table>
        <tbody>
          <Row ok={check.enabled && check.loaded} label="Bridge live" detail={check.enabled ? (check.loaded ? "enabled and loaded" : "enabled but failed to load, see logs") : "disabled"} />
          <Row
            ok={s ? !s.error : null}
            label="Slack bot token"
            detail={s?.error ? <span className="err">{s.error}</span> : <>@{s?.bot} in {s?.team}</>}
          />
          <Row
            ok={missing.length === 0}
            label="Slack bot scopes"
            detail={missing.length ? <span className="err">missing: {missing.join(", ")} — add them in the app's OAuth &amp; Permissions, then reinstall</span> : `all ${s?.scopes?.length ?? 0} granted`}
          />
          <Row
            ok={s?.channel ? Boolean(s.channel.isMember) : null}
            label="Bot in the channel"
            detail={s?.channel?.error ? <span className="err">{s.channel.error}</span> : s?.channel?.isMember ? `#${s.channel.name}` : <span className="err">invite it to #{s?.channel?.name ?? s?.channel?.id}</span>}
          />
          <Row ok={check.chatwoot?.ok ?? null} label="Chatwoot service token" detail={check.chatwoot?.error ? <span className="err">{check.chatwoot.error}</span> : `account ${check.chatwoot?.accountId}, ${check.chatwoot?.agents} agents`} />
          <Row ok={check.threads > 0} label="Threads bridged so far" detail={String(check.threads)} />
          <Row ok={Boolean(b.resolvedEmoji)} label="Bot stamps when resolved" detail={b.resolvedEmoji ? `:${b.resolvedEmoji}: on the question, removed when reopened` : "off"} />
          <Row ok={Boolean(b.reactionResolve)} label="Reaction that resolves" detail={b.reactionResolve ? `:${b.reactionResolve}: — react on the first message of the thread, not on a reply` : "off"} />
          <Row
            ok={Boolean(b.resolveButtonLabel)}
            label="Thread button"
            detail={
              b.resolveButtonLabel
                ? `"${b.resolveButtonLabel}" while open, ${b.reopenButtonLabel ? `"${b.reopenButtonLabel}" while resolved` : "hidden while resolved"} — appears on welcome messages posted after this was set`
                : "off"
            }
          />
          <Row ok={b.welcomeMessage} label="Welcome message" detail={b.welcomeMessage ? "set" : "off"} />
          <Row ok={b.reopenPromptMessage} label="Accidental-reopen prompt" detail={b.reopenPromptMessage ? "set" : "off"} />
          <Row ok={b.followupPromptMessage} label="Second-question check" detail={b.followupPromptMessage ? "set" : "off"} />
          <Row
            ok={null}
            label="Linked account required to post"
            detail={b.requireLink ? (b.linkPromptMessage ? "on — unlinked senders are told privately" : "on — unlinked senders are ignored silently") : "off"}
          />
          <Row ok={b.resolveMessage && b.reopenMessage} label="Resolved / reopened notices" detail={`${b.resolveMessage ? "resolved set" : "resolved off"}, ${b.reopenMessage ? "reopened set" : "reopened off"}`} />
        </tbody>
      </table>
      <h3 className="step">Slack traffic received since the last restart</h3>
      {check.traffic.length === 0 ? (
        <p className="err">
          Nothing at all. Slack is not reaching <code>{check.eventsUrl}</code>: check the Request URL under Event Subscriptions on this bridge's Slack app.
        </p>
      ) : (
        <>
          {!check.traffic.some((t) => t.kind === "event:reaction_added") && (
            <p className="err">
              No <code>reaction_added</code> event has arrived. If you have reacted since the last restart, that event is not subscribed: add it under Event
              Subscriptions → Subscribe to bot events on this bridge's Slack app, then reinstall.
            </p>
          )}
          <table>
            <tbody>
              {check.traffic.map((t, i) => (
                <tr key={i}>
                  <td className="muted" style={{ width: 90, whiteSpace: "nowrap" }}>
                    {new Date(t.at).toLocaleTimeString()}
                  </td>
                  <td style={{ width: 210 }}>
                    <code>{t.kind}</code>
                  </td>
                  <td className="mono">{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="note">
        Slack has no API for reading an app's own event subscriptions or interactivity URL, so those are the two things this cannot verify. Both must point at{" "}
        <code>{check.eventsUrl}</code>, with <code>message.channels</code> and <code>reaction_added</code> subscribed.
      </p>
    </div>
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
      resolvedEmoji: d.resolvedEmoji,
      welcomeMessage: d.welcomeMessage,
      resolveButtonLabel: d.resolveButtonLabel,
      reopenButtonLabel: d.reopenButtonLabel,
      resolveMessage: d.resolveMessage,
      reopenMessage: d.reopenMessage,
      reopenPromptMessage: d.reopenPromptMessage,
      followupPromptMessage: d.followupPromptMessage,
      requireLink: d.requireLink,
      linkPromptMessage: d.linkPromptMessage,
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
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Emoji the bot adds to the question once resolved, and removes when reopened (blank = off)</label>
          <input value={d.resolvedEmoji} onChange={set("resolvedEmoji")} placeholder="white_check_mark" />
          <p className="note">Marks finished threads in the channel list. Custom emoji are fine; give the name without colons.</p>
        </div>
        <div className="field">
          <label>Reaction a person can add to resolve (blank = off)</label>
          <input value={d.reactionResolve} onChange={set("reactionResolve")} placeholder="white_check_mark" />
          <p className="note">Honoured from the asker or a linked agent, on the first message of the thread. Needs <code>reaction_added</code> subscribed.</p>
        </div>
        <div className="field">
          <label>Reaction a linked agent can add to assign it to themselves (blank = off)</label>
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
          <label>Button while open (blank = no button)</label>
          <input value={d.resolveButtonLabel} onChange={set("resolveButtonLabel")} placeholder="Resolve" />
          <p className="note">Needs Interactivity enabled on the bridge's Slack app, pointing at the same request URL as its events.</p>
        </div>
        <div className="field">
          <label>Button while resolved (blank = no button)</label>
          <input value={d.reopenButtonLabel} onChange={set("reopenButtonLabel")} placeholder="Reopen" />
          <p className="note">The welcome message's button is re-labelled whenever Chatwoot reports a status change.</p>
        </div>
        <div className="field">
          <label>Resolved message (requires the conversation_status_changed webhook event)</label>
          <textarea rows={2} value={d.resolveMessage} onChange={set("resolveMessage")} />
        </div>
        <div className="field">
          <label>Reopened message (replaces the resolved message)</label>
          <textarea rows={2} value={d.reopenMessage} onChange={set("reopenMessage")} />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>
            <input
              type="checkbox"
              style={{ width: "auto", marginRight: 6 }}
              checked={d.requireLink}
              onChange={(e) => setD((x) => ({ ...x, requireLink: e.target.checked }))}
            />
            Require a linked Slack account before anything is relayed
          </label>
          <p className="note">
            Off by default. While on, nothing anyone posts in this channel reaches Chatwoot until they have been through <code>{me.publicUrl}/link</code> — there
            is no anonymous route.
          </p>
          <label>Private notice for an unlinked sender (blank = say nothing)</label>
          <textarea rows={2} value={d.linkPromptMessage} onChange={set("linkPromptMessage")} placeholder={me.defaults.linkPromptMessage} />
          <p className="note">
            <code>{"{link}"}</code> is replaced with the link URL. Only that person sees it.
          </p>
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Private prompt when someone's reply reopens a resolved ticket (blank = off)</label>
          <textarea rows={2} value={d.reopenPromptMessage} onChange={set("reopenPromptMessage")} />
          <p className="note">Only that person sees it, with a green button that resolves the ticket again and a red one that keeps it open.</p>
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>Private prompt when someone posts a second question minutes after their first (blank = off)</label>
          <textarea rows={2} value={d.followupPromptMessage} onChange={set("followupPromptMessage")} placeholder={me.defaults.followupPromptMessage} />
          <p className="note">
            Held back for up to 10 minutes while they choose: a separate question opens a ticket as usual, a follow-up opens none and they are asked to move it
            into their earlier thread. No answer means it goes through as a separate question.
          </p>
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


/**
 * Who runs one bridge. Its admins invite operators here — community members who can configure
 * this bridge and nothing else — without a superadmin ever being in the loop.
 */
function MembersPanel({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
  const { data, error, reload } = useResource<BridgeMembers>(`/bridges/${bridge.id}/members`);
  const [notice, setNotice] = useState<string | null>(null);
  const [slackUserId, setSlackUserId] = useState("");
  const [role, setRole] = useState<BridgeRole>("operator");

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(null);
      reload();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>People on {bridge.name}</h3>
        <button className="small" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {notice && <p className="err">{notice}</p>}
      {data && (
        <>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Added</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.slackUserId}>
                  <td>
                    <strong>{m.name ?? m.slackUserId}</strong>
                    <div className="note mono">{m.slackUserId}</div>
                  </td>
                  <td>
                    <span className="pill">{m.role}</span>
                    <div className="note">
                      {m.role === "admin" ? "configures this bridge, invites people, can delete it" : "configures this bridge; cannot invite or delete"}
                    </div>
                  </td>
                  <td className="note">{fmtDate(m.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    {data.canInvite && (
                      <button
                        className="small danger"
                        onClick={() => {
                          if (!confirm(`Remove ${m.name ?? m.slackUserId} from ${bridge.name}?`)) return;
                          void run(() => api.del(`/bridges/${bridge.id}/members/${m.slackUserId}`));
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {data.members.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nobody is assigned to this bridge yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {data.canInvite ? (
            <form
              className="row"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api.post(`/bridges/${bridge.id}/members`, { slackUserId: slackUserId.trim(), role });
                  setSlackUserId("");
                });
              }}
            >
              <input placeholder="Slack user ID, e.g. U0123456789" value={slackUserId} onChange={(e) => setSlackUserId(e.target.value)} required />
              <select value={role} onChange={(e) => setRole(e.target.value as BridgeRole)}>
                <option value="operator">operator — runs this bridge</option>
                <option value="admin">admin — can also invite and delete</option>
              </select>
              <button className="primary">Add</button>
            </form>
          ) : (
            <p className="note">Only this bridge&apos;s admins can add or remove people.</p>
          )}
          <p className="note" style={{ marginTop: 12 }}>
            Superadmins reach every bridge without being listed here: {data.superadmins.map((s) => s.name ?? s.slackUserId).join(", ") || "none"}.
          </p>
        </>
      )}
    </div>
  );
}
