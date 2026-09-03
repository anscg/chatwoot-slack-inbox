import { api, type Me, type Retry } from "../api";
import { fmtDate, useResource } from "./common";

export function Retries(_: { me: Me }) {
  const { data, error, reload } = useResource<Retry[]>("/retries");
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Retry queue</h2>
        <button className="small" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="note">Failed outbound calls. Retried with exponential backoff (30s → 1h) up to 8 attempts, then dropped and logged.</p>
      {error && <p className="err">{error}</p>}
      {data && data.length === 0 && <p className="muted">Queue is empty.</p>}
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Attempts</th>
              <th>Next attempt</th>
              <th>Last error</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>
                  <code>{r.kind}</code>
                  <details>
                    <summary>payload</summary>
                    <pre>{JSON.stringify(r.payload, null, 1)}</pre>
                  </details>
                </td>
                <td>{r.attempts} / 8</td>
                <td className="muted">{fmtDate(r.nextAttemptAt)}</td>
                <td className="mono" style={{ maxWidth: 380, wordBreak: "break-word" }}>
                  {r.lastError}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    className="small"
                    onClick={async () => {
                      await api.post(`/retries/${r.id}/run`);
                      reload();
                    }}
                  >
                    Run now
                  </button>{" "}
                  <button
                    className="small danger"
                    onClick={async () => {
                      await api.del(`/retries/${r.id}`);
                      reload();
                    }}
                  >
                    Drop
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
