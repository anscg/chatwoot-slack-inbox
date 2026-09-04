import { useState, type FormEvent } from "react";
import { api, type GlobalRole, type Me, type Person } from "../api";
import { fmtDate, useResource } from "./common";

const ROLE_HELP: Record<GlobalRole, string> = {
  superadmin: "Runs this install: every bridge, the roster, and the ops pages.",
  admin: "Can create bridges of their own and invite operators onto them. Sees only their own bridges.",
  operator: "No access of their own — only the bridges an admin has added them to.",
};

export function People({ me }: { me: Me }) {
  const { data, error, reload } = useResource<Person[]>("/people");
  const [notice, setNotice] = useState<string | null>(null);
  const [slackUserId, setSlackUserId] = useState("");
  const [role, setRole] = useState<GlobalRole>("admin");

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(null);
      reload();
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post("/people", { slackUserId: slackUserId.trim(), role });
      setSlackUserId("");
    });
  };

  return (
    <>
      <div className="panel">
        <h2>People</h2>
        <p className="note">
          Who may sign in to this control panel, and how far they reach on their own. Which bridges someone can actually touch is set on the bridge itself — a bridge's
          admins invite their own operators without needing anyone here.
        </p>
        {error && <p className="err">{error}</p>}
        {notice && <p className="err">{notice}</p>}
        {data && (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Bridges</th>
                <th>Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.slackUserId}>
                  <td>
                    <strong>{p.name ?? p.slackUserId}</strong>
                    <div className="note mono">{p.slackUserId}</div>
                    {p.invitedBy && <div className="note">invited by {p.invitedBy}</div>}
                  </td>
                  <td>
                    <select
                      value={p.role}
                      onChange={(e) => void run(() => api.put(`/people/${p.slackUserId}`, { role: e.target.value }))}
                      disabled={p.slackUserId === me.user.userId}
                      title={p.slackUserId === me.user.userId ? "You cannot change your own role" : ROLE_HELP[p.role]}
                    >
                      <option value="superadmin">superadmin</option>
                      <option value="admin">admin</option>
                      <option value="operator">operator</option>
                    </select>
                    <div className="note">{ROLE_HELP[p.role]}</div>
                  </td>
                  <td>
                    {p.bridges.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      p.bridges.map((b) => (
                        <div key={b.id}>
                          {b.name ?? `#${b.id}`} <span className="pill">{b.role}</span>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="note">{p.lastSeenAt ? fmtDate(p.lastSeenAt) : <span className="muted">never signed in</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    {p.slackUserId !== me.user.userId && (
                      <button
                        className="small danger"
                        onClick={() => {
                          if (!confirm(`Remove ${p.name ?? p.slackUserId} from the control panel? Their bridge access goes with them.`)) return;
                          void run(() => api.del(`/people/${p.slackUserId}`));
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h3>Add someone</h3>
        <form className="row" onSubmit={add}>
          <input placeholder="Slack user ID, e.g. U0123456789" value={slackUserId} onChange={(e) => setSlackUserId(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
            <option value="admin">admin — can create their own bridges</option>
            <option value="superadmin">superadmin — runs the whole install</option>
            <option value="operator">operator — only what they are invited to</option>
          </select>
          <button className="primary">Add</button>
        </form>
        <p className="note">They sign in at the panel with Slack; nothing is emailed. Find a Slack user ID from their profile → ⋮ → Copy member ID.</p>
      </div>
    </>
  );
}
