import type { App } from "@slack/bolt";
import type { Bridge } from "../bridges.js";
import { ChatwootHttpError } from "../chatwoot/client.js";
import type { AppContext } from "../context.js";
import { describeSlackRequest, recordTraffic } from "../diagnostics.js";
import { decryptToken } from "../crypto.js";
import type { Agent, Thread } from "../db/schema.js";
import { log } from "../logger.js";
import { PermanentError } from "../retry.js";
import { allFilesRelayed, findAgentBySlackUser, findThreadBySlack, insertThread, isRelayedSlack, markEventSeen, recordRelayed, setWelcomeMessageTs } from "../store.js";
import { downloadSlackFiles, type SlackFileRef } from "./files.js";
import { buttonForStatus, parseButtonValue, RESOLVE_ACTION_ID, welcomeBlocks, type ButtonAction } from "./blocks.js";
import { BRIDGE_METADATA_EVENT, postEphemeralInThread, postSystemMessage } from "./post.js";
import { slackToChatwootText } from "./text.js";
import { getSlackProfile } from "./users.js";

export const JOB_SLACK_MESSAGE = "slack_message";
export const JOB_SLACK_REACTION = "slack_reaction";

/** The subset of a Slack message event we persist into the retry payload. */
export interface SlackMessageJob extends Record<string, unknown> {
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: SlackFileRef[];
}

export interface SlackReactionJob extends Record<string, unknown> {
  channel: string;
  /** ts of the message reacted to (must be a thread parent) */
  ts: string;
  user: string;
  action: "resolve" | "assign" | "reopen";
  /** How the action was triggered, for logging only. */
  via?: "reaction" | "button";
}

/**
 * Who may resolve a thread: a linked Chatwoot agent (a helper) or the person who asked.
 * Returns null when allowed, or a reason to refuse.
 */
export async function checkResolvePermission(ctx: AppContext, thread: Thread, userId: string): Promise<string | null> {
  const agent = await findAgentBySlackUser(ctx.db, userId);
  if (agent?.chatwootAgentId) return null;
  if (userId === thread.slackAuthorId) return null;
  return "resolve: not agent or author";
}

/** Minimal shape of the incoming Slack message event we care about. */
export interface IncomingSlackMessage {
  type: "message";
  subtype?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: SlackFileRef[];
  metadata?: { event_type?: string };
}

export interface IncomingSlackReaction {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: { type: string; channel?: string; ts?: string };
}

const RELAYABLE_SUBTYPES = new Set<string | undefined>([undefined, "file_share", "thread_broadcast"]);

/**
 * Decide whether an incoming message event should be relayed and, if so, hand it
 * to the job runner. Does no network I/O itself; returns a reason string when skipping.
 */
export async function acceptSlackMessage(ctx: AppContext, eventId: string, msg: IncomingSlackMessage): Promise<string | null> {
  const bridge = ctx.bridges.forChannel(msg.channel);
  if (!bridge) return "unbridged channel";
  if (!RELAYABLE_SUBTYPES.has(msg.subtype)) return `subtype ${msg.subtype}`;
  if (msg.bot_id && msg.bot_id === bridge.botId) return "own bot message";
  if (msg.user && msg.user === bridge.botUserId) return "own bot user";
  if (msg.metadata?.event_type === BRIDGE_METADATA_EVENT) return "bridge-posted message";
  if (!msg.user) return "no user";
  if (!(await markEventSeen(ctx.db, eventId))) return "duplicate event";
  if (await isRelayedSlack(ctx.db, msg.channel, msg.ts)) return "already relayed";
  if (msg.files?.length && (await allFilesRelayed(ctx.db, msg.files.map((f) => f.id)))) return "bridge-uploaded files";

  const job: SlackMessageJob = { channel: msg.channel, ts: msg.ts, user: msg.user, text: msg.text ?? "" };
  if (msg.thread_ts) job.thread_ts = msg.thread_ts;
  if (msg.files?.length) {
    job.files = msg.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
      url_private_download: f.url_private_download,
      url_private: f.url_private,
    }));
  }
  // Fire and forget: the Slack request is already acked by Bolt; failures land in `retries`.
  void ctx.retry.runOrEnqueue(JOB_SLACK_MESSAGE, job);
  return null;
}

/**
 * Reactions on a thread parent. The permission gate runs here (cheap DB lookups only):
 *  - resolve: linked agent or the thread's original author
 *  - assign: linked agent only
 * Anyone else is ignored silently.
 */
export async function acceptSlackReaction(ctx: AppContext, eventId: string, ev: IncomingSlackReaction): Promise<string | null> {
  if (ev.item.type !== "message" || !ev.item.channel || !ev.item.ts) return "not a message reaction";
  const bridge = ctx.bridges.forChannel(ev.item.channel);
  if (!bridge) return "unbridged channel";
  if (ev.user === bridge.botUserId) return "own reaction";

  let action: SlackReactionJob["action"];
  if (bridge.row.reactionResolve && ev.reaction === bridge.row.reactionResolve) action = "resolve";
  else if (bridge.row.reactionAssign && ev.reaction === bridge.row.reactionAssign) action = "assign";
  else return "unconfigured reaction";

  const thread = await findThreadBySlack(ctx.db, ev.item.channel, ev.item.ts);
  if (!thread) return "not a thread parent";

  if (action === "assign") {
    const agent = await findAgentBySlackUser(ctx.db, ev.user);
    if (!agent?.chatwootAgentId) return "assign: not a linked agent";
  } else {
    const refusal = await checkResolvePermission(ctx, thread, ev.user);
    if (refusal) return refusal;
  }

  if (!(await markEventSeen(ctx.db, eventId))) return "duplicate event";
  const job: SlackReactionJob = { channel: ev.item.channel, ts: ev.item.ts, user: ev.user, action, via: "reaction" };
  void ctx.retry.runOrEnqueue(JOB_SLACK_REACTION, job);
  return null;
}

export interface ResolveButtonClick {
  channel: string;
  /** Thread parent ts, from the button's own value. */
  threadTs: string;
  user: string;
  /** What the button offered when it was clicked. */
  action: ButtonAction;
  /** Unique per interaction; used to drop duplicate deliveries. */
  triggerId: string;
}

/**
 * Handle a click on the welcome message's button. Same permission gate as the ✅ reaction, but a
 * click gets an answer: returns a message to show the clicker privately, or null on success.
 */
export async function acceptResolveButton(ctx: AppContext, click: ResolveButtonClick): Promise<string | null> {
  const bridge = ctx.bridges.forChannel(click.channel);
  if (!bridge) return "This channel is not bridged to Chatwoot any more.";
  const thread = await findThreadBySlack(ctx.db, click.channel, click.threadTs);
  if (!thread) return "I can't find this thread in Chatwoot.";
  const refusal = await checkResolvePermission(ctx, thread, click.user);
  if (refusal) {
    log.info("refused thread button", { reason: refusal, action: click.action, user: click.user, channel: click.channel, ts: click.threadTs });
    return `Only the person who asked or a helper can ${click.action} this thread.`;
  }
  if (!(await markEventSeen(ctx.db, `interaction:${click.triggerId}`))) return null; // duplicate delivery
  const job: SlackReactionJob = { channel: click.channel, ts: click.threadTs, user: click.user, action: click.action, via: "button" };
  void ctx.retry.runOrEnqueue(JOB_SLACK_REACTION, job);
  return null;
}

function agentToken(ctx: AppContext, agent: Agent | undefined): string | undefined {
  return agent?.chatwootApiTokenEnc ? decryptToken(agent.chatwootApiTokenEnc, ctx.config.TOKEN_ENCRYPTION_KEY) : undefined;
}

function permanentIf4xx(err: unknown): never {
  if (err instanceof ChatwootHttpError && err.permanent) throw new PermanentError(err.message);
  throw err;
}

/**
 * A file the bridge uploaded with an agent's user token shows up as a normal user message; the
 * relayed_files row is written right after the upload, so wait briefly before deciding.
 */
export const SLACK_ECHO_GRACE_MS = 1500;

/** Relay one Slack message into Chatwoot. Idempotent: safe to run again from the retry queue. */
export async function relaySlackMessage(ctx: AppContext, job: SlackMessageJob, graceMs = SLACK_ECHO_GRACE_MS): Promise<void> {
  const { db, hub } = ctx;
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const { chatwoot } = bridge;
  if (job.files?.length && graceMs > 0) await new Promise((r) => setTimeout(r, graceMs));
  if (await isRelayedSlack(db, job.channel, job.ts)) return;
  if (job.files?.length && (await allFilesRelayed(db, job.files.map((f) => f.id)))) return;

  const isReply = Boolean(job.thread_ts && job.thread_ts !== job.ts);
  const author = await getSlackProfile(hub, job.user);

  let text = await slackToChatwootText(hub, job.text);
  const { attachments, skipped } = job.files?.length
    ? await downloadSlackFiles(bridge.botToken, job.files) // files are readable by the bot that is in the channel
    : { attachments: [], skipped: [] };
  if (skipped.length) {
    text += `\n\n_(${skipped.length} attachment${skipped.length > 1 ? "s" : ""} could not be forwarded from Slack)_`;
  }
  if (!text.trim() && attachments.length === 0) return; // nothing to relay

  try {
    if (!isReply) {
      // Top-level message: contact -> conversation -> message.
      let thread = await findThreadBySlack(db, job.channel, job.ts);
      if (!thread) {
        const contact = await chatwoot.upsertContact({
          identifier: job.user,
          name: author.name,
          email: author.email,
          avatarUrl: author.avatarUrl,
        });
        const conversation = await chatwoot.createConversation(contact.source_id);
        thread = await insertThread(db, {
          slackChannel: job.channel,
          slackThreadTs: job.ts,
          chatwootAccountId: bridge.row.chatwootAccountId,
          chatwootConversationId: conversation.id,
          chatwootContactSourceId: contact.source_id,
          slackAuthorId: job.user,
        });
        log.info("created conversation", { bridge: bridge.row.name, conversationId: conversation.id, channel: job.channel, ts: job.ts });
        // Keep the Chatwoot contact looking like the Slack user: the public create call doesn't
        // update existing contacts, and Chatwoot may have swapped in a Gravatar. Best effort.
        await chatwoot.updateContact(contact.id, { name: author.name, avatarUrl: author.avatarUrl }).catch((err) => {
          log.warn("could not refresh contact avatar", { contactId: contact.id, error: err instanceof Error ? err.message : String(err) });
        });
        if (bridge.row.welcomeMessage) {
          const blocks = welcomeBlocks(bridge.row.welcomeMessage, job.ts, buttonForStatus("open", bridge.row));
          const welcomeTs = await postSystemMessage(bridge, job.channel, job.ts, bridge.row.welcomeMessage, blocks).catch((err) => {
            log.warn("could not post welcome message", { channel: job.channel, ts: job.ts, error: err instanceof Error ? err.message : String(err) });
            return null;
          });
          if (welcomeTs) await setWelcomeMessageTs(db, thread.id, welcomeTs);
        }
      }
      const message = await chatwoot.createContactMessage(thread.chatwootContactSourceId, thread.chatwootConversationId, text, attachments, job.ts);
      await recordRelayed(db, { slackChannel: job.channel, slackTs: job.ts, chatwootMessageId: message.id, direction: "slack_to_chatwoot" });
      return;
    }

    // Thread reply.
    const thread = await findThreadBySlack(db, job.channel, job.thread_ts!);
    if (!thread) {
      log.info("reply in unmapped thread, ignoring", { channel: job.channel, thread_ts: job.thread_ts });
      return;
    }

    const agent = await findAgentBySlackUser(db, job.user);
    let messageId: number;
    if (agent?.chatwootAgentId) {
      // Linked agent: outgoing message attributed to them via their own API token.
      const apiToken = agentToken(ctx, agent);
      const content = apiToken ? text : `**${author.name}:** ${text}`; // no token -> service agent posts, so name them
      const message = await chatwoot.createAgentMessage(thread.chatwootConversationId, content, { apiToken, attachments });
      messageId = message.id;
    } else {
      // Not an agent: post as the contact. If someone other than the OP replies, flag it.
      const content = job.user === thread.slackAuthorId ? text : `**[Not OP] ${author.name}:** ${text}`;
      const message = await chatwoot.createContactMessage(thread.chatwootContactSourceId, thread.chatwootConversationId, content, attachments, job.ts);
      messageId = message.id;
    }
    await recordRelayed(db, { slackChannel: job.channel, slackTs: job.ts, chatwootMessageId: messageId, direction: "slack_to_chatwoot" });
  } catch (err) {
    permanentIf4xx(err);
  }
}

/** Apply a ✅/👀 reaction to the Chatwoot conversation. The permission gate already ran in acceptSlackReaction. */
export async function applySlackReaction(ctx: AppContext, job: SlackReactionJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const thread = await findThreadBySlack(ctx.db, job.channel, job.ts);
  if (!thread) throw new PermanentError("thread vanished");
  const agent = await findAgentBySlackUser(ctx.db, job.user);

  try {
    if (job.action === "assign") {
      if (!agent?.chatwootAgentId) throw new PermanentError("assign by non-agent");
      await bridge.chatwoot.assignConversation(thread.chatwootConversationId, agent.chatwootAgentId, agentToken(ctx, agent));
      log.info("assigned conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, agentId: agent.chatwootAgentId });
      return;
    }
    if (job.action === "reopen") {
      await reopenConversation(bridge, thread, agent, agentToken(ctx, agent));
      log.info("reopened conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, by: job.user, via: job.via ?? "button" });
      return;
    }
    await resolveConversation(bridge, thread, agent, agentToken(ctx, agent));
    log.info("resolved conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, by: job.user, via: job.via ?? "reaction" });
  } catch (err) {
    permanentIf4xx(err);
  }
}

async function resolveConversation(bridge: Bridge, thread: Thread, agent: Agent | undefined, token: string | undefined): Promise<void> {
  if (agent?.chatwootAgentId) {
    await bridge.chatwoot.toggleStatusAsAgent(thread.chatwootConversationId, "resolved", token);
    return;
  }
  // Original author: the public endpoint only *toggles*, so check the status first to avoid reopening.
  if ((await contactSideStatus(bridge, thread)) === "resolved") return;
  await bridge.chatwoot.toggleStatusAsContact(thread.chatwootContactSourceId, thread.chatwootConversationId);
}

async function reopenConversation(bridge: Bridge, thread: Thread, agent: Agent | undefined, token: string | undefined): Promise<void> {
  if (agent?.chatwootAgentId) {
    await bridge.chatwoot.toggleStatusAsAgent(thread.chatwootConversationId, "open", token);
    return;
  }
  // Same toggle, mirrored: only flip when it really is resolved, or we would resolve an open one.
  if ((await contactSideStatus(bridge, thread)) !== "resolved") return;
  await bridge.chatwoot.toggleStatusAsContact(thread.chatwootContactSourceId, thread.chatwootConversationId);
}

async function contactSideStatus(bridge: Bridge, thread: Thread): Promise<string | undefined> {
  const convs = await bridge.chatwoot.listContactConversations(thread.chatwootContactSourceId);
  return convs.find((c) => c.id === thread.chatwootConversationId)?.status;
}

/** Register the retry-job handlers once per process. */
export function registerSlackJobs(ctx: AppContext): void {
  ctx.retry.register(JOB_SLACK_MESSAGE, (payload) => relaySlackMessage(ctx, payload as SlackMessageJob));
  ctx.retry.register(JOB_SLACK_REACTION, (payload) => applySlackReaction(ctx, payload as SlackReactionJob));
}

/** Attach listeners to one bridge's Bolt app. Events are still validated against the channel mapping. */
export function registerSlackEvents(app: App, ctx: AppContext, bridgeId: number): void {
  // Record everything Slack sends this bridge, before any filtering, so the panel can show whether
  // an event arrived at all. This is the difference between "Slack isn't sending it" and "we
  // decided to ignore it".
  app.use(async ({ body, next }) => {
    const { kind, detail } = describeSlackRequest(body);
    recordTraffic(bridgeId, kind, detail);
    await next();
  });

  app.event("message", async ({ event, body }) => {
    const eventId = (body as { event_id?: string }).event_id ?? `${event.channel}:${(event as { ts: string }).ts}`;
    const reason = await acceptSlackMessage(ctx, eventId, event as unknown as IncomingSlackMessage);
    if (reason) log.debug("skipping slack message", { reason, eventId });
  });

  app.action({ action_id: RESOLVE_ACTION_ID }, async ({ ack, body }) => {
    await ack(); // Slack wants an ack within 3s; everything else happens after.
    const b = body as unknown as {
      user?: { id?: string };
      channel?: { id?: string };
      trigger_id?: string;
      message?: { thread_ts?: string; ts?: string };
      actions?: { value?: string }[];
    };
    const channel = b.channel?.id;
    const user = b.user?.id;
    const parsed = parseButtonValue(b.actions?.[0]?.value) ?? { action: "resolve" as ButtonAction, threadTs: b.message?.thread_ts ?? b.message?.ts ?? "" };
    if (!channel || !user || !parsed.threadTs) {
      log.warn("thread button click missing context", { channel, user, value: b.actions?.[0]?.value });
      return;
    }
    const bridge = ctx.bridges.forChannel(channel);
    const problem = await acceptResolveButton(ctx, { channel, ...parsed, user, triggerId: b.trigger_id ?? `${channel}:${parsed.threadTs}:${user}` });
    if (!bridge) return;
    const done = parsed.action === "reopen" ? "Thread reopened." : "Marked as resolved.";
    await postEphemeralInThread(bridge, channel, parsed.threadTs, user, problem ?? done).catch((err) =>
      log.warn("could not answer thread button click", { error: err instanceof Error ? err.message : String(err) }),
    );
  });

  app.event("reaction_added", async ({ event, body }) => {
    const eventId = (body as { event_id?: string }).event_id ?? `${event.event_ts}`;
    const ev = event as unknown as IncomingSlackReaction;
    const reason = await acceptSlackReaction(ctx, eventId, ev);
    // Both outcomes at info level: "did the reaction reach us, and what did we decide" must be
    // answerable from the logs alone.
    recordTraffic(bridgeId, "decision", `:${ev.reaction}: -> ${reason ?? "accepted"}`);
    if (reason) log.info("ignoring slack reaction", { reason, user: ev.user, reaction: ev.reaction, ts: ev.item?.ts, eventId });
    else log.info("accepted slack reaction", { user: ev.user, reaction: ev.reaction, ts: ev.item?.ts, eventId });
  });
}
