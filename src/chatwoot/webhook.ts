import { timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { log } from "../logger.js";
import { PermanentError } from "../retry.js";
import { postToSlackThread, resolvePostIdentity, type ChatwootSenderRef } from "../slack/post.js";
import { chatwootToSlackText } from "../slack/text.js";
import { findThreadByConversation, isRelayedChatwoot, recordRelayed } from "../store.js";

export const JOB_CHATWOOT_MESSAGE = "chatwoot_message";

/**
 * Chatwoot fires the webhook for messages the bridge itself created via the API a
 * moment before we've written the `relayed` row. Wait briefly before deciding.
 */
export const ECHO_GRACE_MS = 1500;

export interface ChatwootWebhookPayload {
  event?: string;
  id?: number;
  content?: string | null;
  message_type?: "incoming" | "outgoing" | "activity" | "template" | number;
  private?: boolean;
  account?: { id?: number };
  conversation?: { id?: number; inbox_id?: number };
  sender?: (ChatwootSenderRef & { type?: string; email?: string }) | null;
  attachments?: { data_url?: string; file_type?: string; extension?: string | null }[];
  content_attributes?: Record<string, unknown>;
}

/** (conversationId:agentId) pairs already nudged to link, so we don't spam notes. Resets on restart. */
const linkNudges = new Set<string>();

export interface ChatwootMessageJob extends Record<string, unknown> {
  messageId: number;
  accountId: number;
  conversationId: number;
  content: string;
  sender: ChatwootSenderRef | null;
  attachments: { url: string; type: string }[];
}

/** Validate + shape a webhook body into a job. Returns a skip reason or the job. No I/O. */
export function classifyWebhook(body: ChatwootWebhookPayload): { skip: string } | { job: ChatwootMessageJob } {
  if (body.event !== "message_created") return { skip: `event ${body.event}` };
  if (body.message_type !== "outgoing" && body.message_type !== 1) return { skip: `message_type ${body.message_type}` };
  if (body.private) return { skip: "private note" };
  const messageId = body.id;
  const accountId = body.account?.id;
  const conversationId = body.conversation?.id;
  if (!messageId || !accountId || !conversationId) return { skip: "missing ids" };
  const attachments = (body.attachments ?? [])
    .filter((a) => a.data_url)
    .map((a) => ({ url: a.data_url!, type: a.file_type ?? "file" }));
  const content = body.content ?? "";
  if (!content.trim() && attachments.length === 0) return { skip: "empty" };
  const sender = body.sender ? { id: body.sender.id, name: body.sender.name, avatar_url: body.sender.avatar_url } : null;
  return { job: { messageId, accountId, conversationId, content, sender, attachments } };
}

/** Relay one Chatwoot agent message into the mapped Slack thread. Idempotent. */
export async function relayChatwootMessage(ctx: AppContext, job: ChatwootMessageJob, graceMs = ECHO_GRACE_MS): Promise<void> {
  if (graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
  if (await isRelayedChatwoot(ctx.db, job.messageId)) return; // our own message coming back, or already sent
  const thread = await findThreadByConversation(ctx.db, job.accountId, job.conversationId);
  if (!thread) {
    log.debug("chatwoot message for unmapped conversation", { accountId: job.accountId, conversationId: job.conversationId });
    return;
  }
  const bridge = ctx.bridges.forChannel(thread.slackChannel);
  if (!bridge) throw new PermanentError(`no enabled bridge for channel ${thread.slackChannel}`);

  let text = chatwootToSlackText(job.content);
  if (job.attachments.length) {
    const links = job.attachments.map((a, i) => `<${a.url}|${a.type} ${i + 1}>`).join("  ");
    text = text.trim() ? `${text}\n${links}` : links;
  }
  const identity = await resolvePostIdentity(ctx, job.sender);
  const ts = await postToSlackThread(ctx, bridge, {
    channel: thread.slackChannel,
    threadTs: thread.slackThreadTs,
    text,
    identity,
    chatwootMessageId: job.messageId,
  });
  await recordRelayed(ctx.db, { slackChannel: thread.slackChannel, slackTs: ts, chatwootMessageId: job.messageId, direction: "chatwoot_to_slack" });
  log.info("relayed chatwoot message to slack", { bridge: bridge.row.name, conversationId: job.conversationId, as: identity.kind });

  // Agents are expected to post as themselves. If this one hasn't linked Slack yet, tell them (privately, once).
  if (identity.kind === "bot" && job.sender?.id) {
    const key = `${job.conversationId}:${job.sender.id}`;
    if (!linkNudges.has(key)) {
      linkNudges.add(key);
      const note =
        `**Your reply was posted to Slack by the ${bridge.row.name} bot, not as you.** ` +
        `Link your Slack account so replies come from your own account: ${ctx.config.PUBLIC_URL}/link`;
      await bridge.chatwoot.createAgentMessage(job.conversationId, note, { private: true }).catch((err) => {
        log.warn("could not post link nudge", { conversationId: job.conversationId, error: err instanceof Error ? err.message : String(err) });
      });
    }
  }
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerChatwootWebhook(router: Router, ctx: AppContext): void {
  ctx.retry.register(JOB_CHATWOOT_MESSAGE, (payload) => relayChatwootMessage(ctx, payload as ChatwootMessageJob));

  router.post("/webhooks/chatwoot/:secret", (req: Request, res: Response) => {
    const secret = String(req.params.secret ?? "");
    if (!secretMatches(secret, ctx.config.CHATWOOT_WEBHOOK_SECRET)) {
      res.status(404).end();
      return;
    }
    const result = classifyWebhook((req.body ?? {}) as ChatwootWebhookPayload);
    res.status(200).json({ ok: true }); // ack first
    if ("skip" in result) {
      log.debug("skipping chatwoot webhook", { reason: result.skip });
      return;
    }
    void ctx.retry.runOrEnqueue(JOB_CHATWOOT_MESSAGE, result.job);
  });
}
