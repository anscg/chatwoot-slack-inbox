import { useState } from "react";
import { api, type Agent, type ChatwootAgentSummary, type Me } from "../api";
import { fmtDate, useResource } from "./common";

export function Agents(_: { me: Me }) {
  const { data, error, reload } = useResource<Agent[]>("/agents");
  const cwAgents = useResource<ChatwootAgentSummary[]>("/chatwoot/agents");
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="panel">
      <h2>Agents</h2>
      <p className="note">
        Agents appear here after visiting <code>/link</code>, which matches them to a Chatwoot agent by email. If the emails differ, set the Chatwoot agent by hand
        in the third column. A Slack token lets Chatwoot replies post as them; a Chatwoot token lets their Slack replies be attributed to them in Chatwoot.
      </p>
      {error && <p className="err">{error}</p>}
      {err && <p className="err">{err}</p>}
      <table>
        <thead>
          <tr>
            <th>Slack user</th>
            <th>Email</th>
            <th>Chatwoot agent</th>
            <th>Slack token</th>
            <th>Chatwoot token</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.map((a) => (
            <AgentRow key={a.id} a={a} cwAgents={cwAgents.data ?? []} onChange={reload} onError={setErr} />
          ))}
          <tr>
            <td colSpan={5}>
              <input placeholder="Pre-create by Slack user ID (U0123456789)" value={newId} onChange={(e) => setNewId(e.target.value.trim())} style={{ maxWidth: 360 }} />
            </td>
            <td style={{ textAlign: "right" }}>
              <button
                className="small"
                disabled={!newId}
                onClick={async () => {
                  try {
                    await api.post("/agents", { slackUserId: newId });
                    setNewId("");
                    reload();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ a, cwAgents, onChange, onError }: { a: Agent; cwAgents: ChatwootAgentSummary[]; onChange: () => void; onError: (m: string | null) => void }) {
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pick, setPick] = useState<string>(a.chatwootAgentId ? String(a.chatwootAgentId) : "");
  const [email, setEmail] = useState("");
  const matched = cwAgents.find((c) => c.id === a.chatwootAgentId);

  async function saveLink(body: { chatwootAgentId?: number | null; email?: string }) {
    try {
      await api.put(`/agents/${a.id}/chatwoot-agent`, body);
      onError(null);
      setLinking(false);
      setEmail("");
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <tr>
      <td>
        <code>{a.slackUserId}</code>
        <div className="note">{fmtDate(a.createdAt)}</div>
      </td>
      <td>{a.email ?? <span className="muted">—</span>}</td>
      <td>
        {linking ? (
          <span className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, maxWidth: 280 }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick a Chatwoot agent…</option>
              {cwAgents.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.email ? `<${c.email}>` : ""} · acct {c.accounts.join(", ")}
                </option>
              ))}
            </select>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="…or match by Chatwoot email" />
            <span className="row">
              <button
                className="small primary"
                disabled={!pick && !email}
                onClick={() => (email ? saveLink({ email }) : saveLink({ chatwootAgentId: Number(pick) }))}
              >
                Save
              </button>
              {a.chatwootAgentId && (
                <button className="small" onClick={() => saveLink({ chatwootAgentId: null })}>
                  Unlink
                </button>
              )}
              <button className="small" onClick={() => setLinking(false)}>
                Cancel
              </button>
            </span>
          </span>
        ) : a.chatwootAgentId ? (
          <span className="row">
            <span>
              {matched?.name ?? <code>#{a.chatwootAgentId}</code>}
              {matched?.email && <div className="note">{matched.email}</div>}
            </span>
            <button className="small" onClick={() => setLinking(true)}>
              Change
            </button>
          </span>
        ) : (
          <span className="row">
            <span className="pill warn">not matched</span>
            <button className="small" onClick={() => setLinking(true)}>
              Link
            </button>
          </span>
        )}
      </td>
      <td>{a.hasSlackToken ? <span className="pill ok">linked</span> : <span className="pill off">none</span>}</td>
      <td>
        {editing ? (
          <span className="row">
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Chatwoot access token" style={{ width: 220 }} autoComplete="off" />
            <button
              className="small primary"
              disabled={!token}
              onClick={async () => {
                try {
                  await api.put(`/agents/${a.id}/chatwoot-token`, { apiToken: token });
                  onError(null);
                  setEditing(false);
                  setToken("");
                  onChange();
                } catch (e) {
                  onError((e as Error).message);
                }
              }}
            >
              Save
            </button>
            <button className="small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        ) : a.hasChatwootToken ? (
          <span className="row">
            <span className="pill ok">set</span>
            <button className="small" onClick={() => setEditing(true)}>
              Rotate
            </button>
            <button
              className="small"
              onClick={async () => {
                await api.del(`/agents/${a.id}/chatwoot-token`);
                onChange();
              }}
            >
              Remove
            </button>
          </span>
        ) : (
          <button className="small" onClick={() => setEditing(true)}>
            Attach token
          </button>
        )}
      </td>
      <td style={{ textAlign: "right" }}>
        <button
          className="small danger"
          onClick={async () => {
            if (!confirm(`Remove agent ${a.slackUserId}? They can re-link at /link.`)) return;
            await api.del(`/agents/${a.id}`);
            onChange();
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}
