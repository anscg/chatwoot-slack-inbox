import { timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { log } from "../logger.js";
import { PermanentError } from "../retry.js";
import { buttonForStatus, messageBlocks } from "../slack/blocks.js";
import { deleteSystemMessage, postSystemMessage, postToSlackThread, resolvePostIdentity, setBotReaction, SlackUploadUnavailable, ThreadGone, updateSystemMessage, uploadToSlackThread, type ChatwootSenderRef, type UploadFile } from "../slack/post.js";
import { chatwootToSlackText } from "../slack/text.js";
import { findThreadByConversation, isRelayedChatwoot, markThreadDeleted, recordRelayed, recordRelayedFiles, setThreadStatus } from "../store.js";

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** Events an API inbox webhook sends constantly; logged at debug so the useful lines stay visible. */
const CHATTY_EVENTS = new Set(["conversation_typing_on", "conversation_typing_off", "conversation_updated"]);

/** Download Chatwoot attachments so they can be re-uploaded to Slack. Failures fall back to links. */
async function downloadAttachments(fetchFn: typeof fetch, attachments: ChatwootMessageJob["attachments"]): Promise<{ files: UploadFile[]; failed: ChatwootMessageJob["attachments"] }> {
  const files: UploadFile[] = [];
  const failed: ChatwootMessageJob["attachments"] = [];
  for (const a of attachments) {
    try {
      const res = await fetchFn(a.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`size ${buf.length}`);
      files.push({ data: buf, filename: filenameFor(a.url, res.headers.get("content-type"), a.type) });
    } catch (err) {
      log.warn("could not download chatwoot attachment; will link instead", { url: a.url, error: err instanceof Error ? err.message : String(err) });
      failed.push(a);
    }
  }
  return { files, failed };
}

function filenameFor(url: string, contentType: string | null, type: string): string {
  const fromUrl = decodeURIComponent(new URL(url, "https://x").pathname.split("/").pop() ?? "");
  if (fromUrl && /\.[a-z0-9]{1,5}$/i.test(fromUrl)) return fromUrl;
  const ext = contentType?.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg");
  return `${type || "file"}${ext ? `.${ext}` : ""}`;
}

export const JOB_CHATWOOT_MESSAGE = "chatwoot_message";
export const JOB_CHATWOOT_STATUS = "chatwoot_status";

/**
 * Chatwoot fires the webhook for messages the bridge itself created via the API a
 * moment before we've written the `relayed` row. Wait briefly before deciding.
 */
export const ECHO_GRACE_MS = 1500;

export interface ChatwootWebhookPayload {
  event?: string;
  id?: number;
  /** conversation_* events: the conversation itself is the payload. */
  status?: string;
  inbox_id?: number;
  messages?: { account_id?: number }[];
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

export interface ChatwootStatusJob extends Record<string, unknown> {
  conversationId: number;
  status: string;
  /** Known when the payload carries it; otherwise resolved from inboxId at run time. */
  accountId?: number;
  inboxId?: number;
}

/** Validate + shape a webhook body into a job. Returns a skip reason or the job. No I/O. */
export function classifyWebhook(body: ChatwootWebhookPayload): { skip: string } | { job: ChatwootMessageJob } | { statusJob: ChatwootStatusJob } {
  if (body.event === "conversation_status_changed") {
    if (!body.id || !body.status) return { skip: "missing ids" };
    const accountId = body.account?.id ?? body.messages?.find((m) => m.account_id)?.account_id;
    const inboxId = body.inbox_id ?? body.conversation?.inbox_id;
    return { statusJob: { conversationId: body.id, status: body.status, ...(accountId ? { accountId } : {}), ...(inboxId ? { inboxId } : {}) } };
  }
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
  if (thread.deletedAt) {
    log.debug("skipping relay: the slack thread was deleted", { conversationId: job.conversationId });
    return;
  }
  const bridge = ctx.bridges.forChannel(thread.slackChannel);
  if (!bridge) throw new PermanentError(`no enabled bridge for channel ${thread.slackChannel}`);

  let text = chatwootToSlackText(job.content);
  const identity = await resolvePostIdentity(ctx, job.sender);

  // Attachments: download from Chatwoot and upload into the thread. Anything that can't be
  // downloaded or uploaded is appended as a link so nothing is lost.
  let linkable = job.attachments;
  let ts: string | undefined;
  let uploaded = false;
  if (job.attachments.length) {
    const { files, failed } = await downloadAttachments(ctx.fetch ?? fetch, job.attachments);
    linkable = failed;
    if (files.length) {
      try {
        const up = await uploadToSlackThread(ctx, bridge, {
          channel: thread.slackChannel,
          threadTs: thread.slackThreadTs,
          text: failed.length ? text : text, // links for failures are posted below if needed
          identity,
          files,
          chatwootMessageId: job.messageId,
        });
        await recordRelayedFiles(ctx.db, up.fileIds, job.messageId);
        ts = up.ts ?? `upload:${up.fileIds[0] ?? job.messageId}`;
        uploaded = true;
        text = ""; // already sent as the upload's comment
      } catch (err) {
        if (!(err instanceof SlackUploadUnavailable)) throw err;
        log.warn("slack upload unavailable; posting links", { bridge: bridge.row.name, error: err.message });
        linkable = job.attachments;
      }
    }
  }
  if (linkable.length) {
    const links = linkable.map((a, i) => `<${a.url}|${a.type} ${i + 1}>`).join("  ");
    text = text.trim() ? `${text}\n${links}` : links;
  }
  if (text.trim()) {
    try {
      ts = await postToSlackThread(ctx, bridge, {
        channel: thread.slackChannel,
        threadTs: thread.slackThreadTs,
        text,
        identity,
        chatwootMessageId: job.messageId,
      });
    } catch (err) {
      if (!(err instanceof ThreadGone)) throw err;
      // The question was deleted without us seeing the event; stop trying.
      await markThreadDeleted(ctx.db, thread.id);
      log.warn("slack thread is gone; marking it deleted", { conversationId: job.conversationId, channel: thread.slackChannel });
      return;
    }
  }
  if (!ts) return; // nothing to send (shouldn't happen: classifyWebhook drops empty messages)
  await recordRelayed(ctx.db, { slackChannel: thread.slackChannel, slackTs: ts, chatwootMessageId: job.messageId, direction: "chatwoot_to_slack" });
  if (uploaded) log.debug("uploaded chatwoot attachments to slack", { conversationId: job.conversationId, count: job.attachments.length - linkable.length });
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

/**
 * Post/replace the bot's status notice in the Slack thread when Chatwoot resolves or reopens.
 * Only the latest notice is kept: reopening deletes the "resolved" notice and vice versa.
 */
export async function applyChatwootStatus(ctx: AppContext, job: ChatwootStatusJob): Promise<void> {
  let accountId = job.accountId;
  if (!accountId && job.inboxId) accountId = ctx.bridges.all().find((b) => b.row.chatwootInboxId === job.inboxId)?.row.chatwootAccountId;
  if (!accountId) {
    log.warn("status change without resolvable account; is chatwoot_inbox_id set on the bridge?", { conversationId: job.conversationId, inboxId: job.inboxId });
    return;
  }
  const thread = await findThreadByConversation(ctx.db, accountId, job.conversationId);
  if (!thread || thread.deletedAt) return;
  const bridge = ctx.bridges.forChannel(thread.slackChannel);
  if (!bridge) throw new PermanentError(`no enabled bridge for channel ${thread.slackChannel}`);
  if (thread.lastStatus === job.status) return; // duplicate delivery

  let text: string | null = null;
  if (job.status === "resolved") text = bridge.row.resolveMessage;
  else if (job.status === "open" && thread.lastStatus === "resolved") text = bridge.row.reopenMessage;

  // Stamp the question itself so the channel view shows at a glance which threads are done.
  // The bot's own reaction is ignored on the way back in, so this cannot trigger a resolve loop.
  if (bridge.row.resolvedEmoji && (job.status === "resolved" || job.status === "open")) {
    await setBotReaction(bridge, thread.slackChannel, thread.slackThreadTs, bridge.row.resolvedEmoji, job.status === "resolved").catch((err) =>
      log.warn("could not set the resolved reaction", { conversationId: job.conversationId, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  // The button that fits the new state: Reopen once resolved, Resolve once open again. It goes on
  // the notice as well as the welcome message, so whoever is reading the newest message can act.
  const button = buttonForStatus(job.status, bridge.row);

  let statusMessageTs = thread.statusMessageTs;
  if (text !== null || job.status === "resolved" || job.status === "open") {
    if (statusMessageTs && (text || job.status === "open")) {
      await deleteSystemMessage(bridge, thread.slackChannel, statusMessageTs);
      statusMessageTs = null;
    }
    if (text) {
      statusMessageTs = await postSystemMessage(bridge, thread.slackChannel, thread.slackThreadTs, text, messageBlocks(text, thread.slackThreadTs, button));
    }
  }
  await setThreadStatus(ctx.db, thread.id, { lastStatus: job.status, statusMessageTs });

  // Flip the welcome message's button between Resolve and Reopen.
  if (thread.welcomeMessageTs && bridge.row.welcomeMessage) {
    await updateSystemMessage(
      bridge,
      thread.slackChannel,
      thread.welcomeMessageTs,
      bridge.row.welcomeMessage,
      messageBlocks(bridge.row.welcomeMessage, thread.slackThreadTs, button),
    ).catch((err) => log.warn("could not re-label the thread button", { conversationId: job.conversationId, error: err instanceof Error ? err.message : String(err) }));
  }
  log.info("conversation status changed", { bridge: bridge.row.name, conversationId: job.conversationId, status: job.status, notice: Boolean(text) });
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerChatwootWebhook(router: Router, ctx: AppContext): void {
  ctx.retry.register(JOB_CHATWOOT_MESSAGE, (payload) => relayChatwootMessage(ctx, payload as ChatwootMessageJob));
  ctx.retry.register(JOB_CHATWOOT_STATUS, (payload) => applyChatwootStatus(ctx, payload as ChatwootStatusJob));

  router.post("/webhooks/chatwoot/:secret", (req: Request, res: Response) => {
    const secret = String(req.params.secret ?? "");
    const body = (req.body ?? {}) as ChatwootWebhookPayload;
    if (!secretMatches(secret, ctx.config.CHATWOOT_WEBHOOK_SECRET)) {
      // Loud on purpose. A wrong secret is the usual reason Chatwoot -> Slack goes quiet, and
      // Chatwoot only surfaces it as "404 Not Found" against the message, never as a config error.
      log.warn("rejected chatwoot webhook: the secret in the URL does not match CHATWOOT_WEBHOOK_SECRET", {
        from: req.ip,
        event: body.event,
        gotSecretLength: secret.length,
        expectedSecretLength: ctx.config.CHATWOOT_WEBHOOK_SECRET.length,
      });
      res.status(404).end();
      return;
    }
    const result = classifyWebhook(body);
    res.status(200).json({ ok: true }); // ack first
    // Info level so "did Chatwoot reach us at all?" is answerable from the logs. An API inbox's
    // webhook_url receives every event with no subscription filter, so keep the chatty ones at debug.
    const line = {
      event: body.event,
      messageType: body.message_type,
      conversationId: body.conversation?.id ?? body.id,
      outcome: "skip" in result ? `skipped: ${result.skip}` : "queued",
    };
    if (CHATTY_EVENTS.has(body.event ?? "")) log.debug("chatwoot webhook", line);
    else log.info("chatwoot webhook", line);
    if ("skip" in result) return;
    if ("statusJob" in result) {
      void ctx.retry.runOrEnqueue(JOB_CHATWOOT_STATUS, result.statusJob);
      return;
    }
    void ctx.retry.runOrEnqueue(JOB_CHATWOOT_MESSAGE, result.job);
  });
}
