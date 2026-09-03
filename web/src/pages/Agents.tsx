import { useState } from "react";
import { api, type Agent, type Me } from "../api";
import { fmtDate, useResource } from "./common";

export function Agents(_: { me: Me }) {
  const { data, error, reload } = useResource<Agent[]>("/agents");
  const [newId, setNewId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="panel">
      <h2>Agents</h2>
      <p className="note">
        Agents appear here after visiting <code>/link</code>. A Slack token lets Chatwoot replies post as them; a Chatwoot token lets their Slack replies be attributed to
        them in Chatwoot. Paste each agent's Chatwoot access token (Profile settings → Access token) below.
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
            <AgentRow key={a.id} a={a} onChange={reload} onError={setErr} />
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

function AgentRow({ a, onChange, onError }: { a: Agent; onChange: () => void; onError: (m: string | null) => void }) {
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  return (
    <tr>
      <td>
        <code>{a.slackUserId}</code>
        <div className="note">{fmtDate(a.createdAt)}</div>
      </td>
      <td>{a.email ?? <span className="muted">—</span>}</td>
      <td>{a.chatwootAgentId ? <code>#{a.chatwootAgentId}</code> : <span className="pill warn">not matched</span>}</td>
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
