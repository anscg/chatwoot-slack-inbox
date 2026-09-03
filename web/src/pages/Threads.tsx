import type { Me, Thread } from "../api";
import { fmtTs, slackThreadUrl, useResource } from "./common";

export function Threads({ me }: { me: Me }) {
  const { data, error, reload } = useResource<Thread[]>("/threads?limit=100");
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Recent threads</h2>
        <button className="small" onClick={reload}>
          Refresh
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {data && data.length === 0 && <p className="muted">Nothing bridged yet.</p>}
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Bridge</th>
              <th>Slack</th>
              <th>Chatwoot</th>
              <th>Author</th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td className="muted">{fmtTs(t.slackThreadTs)}</td>
                <td>{t.bridge ?? <span className="pill off">no bridge</span>}</td>
                <td>
                  <a href={slackThreadUrl(t.slackChannel, t.slackThreadTs)} target="_blank" rel="noreferrer">
                    open thread
                  </a>{" "}
                  <span className="muted mono">{t.slackThreadTs}</span>
                </td>
                <td>
                  <a href={`${me.chatwootBaseUrl}/app/accounts/${t.chatwootAccountId}/conversations/${t.chatwootConversationId}`} target="_blank" rel="noreferrer">
                    conversation #{t.chatwootConversationId}
                  </a>{" "}
                  <span className="muted">acct {t.chatwootAccountId}</span>
                </td>
                <td>
                  <code>{t.slackAuthorId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
