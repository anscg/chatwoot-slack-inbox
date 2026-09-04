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
        {data?.webhookUrl && (
          <>
            <p>
              <strong>Chatwoot webhook.</strong> Paste this into each bridged API inbox: Settings → Inboxes → the inbox → Configuration →{" "}
              <strong>Webhook URL</strong>. That delivers every event with nothing to subscribe to. If you use an account-level webhook (Settings → Integrations →
              Webhooks) instead, it must be subscribed to both <code>message_created</code> and <code>conversation_status_changed</code>.
            </p>
            <Copy value={data.webhookUrl} />
          </>
        )}
        <p style={{ marginTop: 16 }}>
          <strong>Agent linking.</strong> Send agents this link. It connects their Slack account so Chatwoot replies post as them and Slack replies are attributed to
          them in Chatwoot.
        </p>
        {data && <Copy value={data.linkUrl} />}
        {me.can.managePeople && (
          <p style={{ marginTop: 16 }}>
            <strong>Hub Slack app.</strong> Setting up another instance, or rotating the hub app? The pre-filled manifest is at <a href="/setup">/setup</a> (no sign-in needed).
          </p>
        )}
        <p className="note" style={{ marginTop: 16 }}>
          Chatwoot: <a href={me.chatwootBaseUrl}>{me.chatwootBaseUrl}</a> · Public URL: <code>{me.publicUrl}</code>
        </p>
      </div>
    </>
  );
}
