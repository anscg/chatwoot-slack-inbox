import type { Me, Status } from "../api";
import { Copy, useResource } from "./common";

export function Overview({ me }: { me: Me }) {
  const { data, error } = useResource<Status>("/status");
  return (
    <>
      <div className="panel">
        <h2>Status</h2>
        {error && <p className="err">{error}</p>}
        {data && (
          <div className="grid">
            <div className="stat"><div className="n">{data.counts.threads}</div><div className="l">bridged threads</div></div>
            <div className="stat"><div className="n">{data.counts.relayed}</div><div className="l">messages relayed</div></div>
            <div className="stat"><div className="n">{data.counts.agents}</div><div className="l">linked agents</div></div>
            <div className="stat"><div className="n">{data.counts.retries}</div><div className="l">pending retries</div></div>
          </div>
        )}
      </div>
      <div className="panel">
        <h2>Setup</h2>
        <p>
          <strong>Chatwoot webhook.</strong> In each bridged Chatwoot account: Settings → Integrations → Webhooks → add this URL and subscribe to{" "}
          <code>message_created</code>.
        </p>
        {data && <Copy value={data.webhookUrl} />}
        <p style={{ marginTop: 16 }}>
          <strong>Agent linking.</strong> Send agents this link. It connects their Slack account so Chatwoot replies post as them and Slack replies are attributed to
          them in Chatwoot.
        </p>
        {data && <Copy value={data.linkUrl} />}
        <p className="note" style={{ marginTop: 16 }}>
          Chatwoot: <a href={me.chatwootBaseUrl}>{me.chatwootBaseUrl}</a> · Public URL: <code>{me.publicUrl}</code>
        </p>
      </div>
    </>
  );
}
