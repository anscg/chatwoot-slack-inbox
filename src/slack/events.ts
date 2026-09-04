import type { App } from "@slack/bolt";
import { agentChatwootToken } from "../agents.js";
import type { Bridge } from "../bridges.js";
import { ChatwootHttpError } from "../chatwoot/client.js";
import type { AppContext } from "../context.js";
import { describeSlackRequest, recordTraffic } from "../diagnostics.js";
import type { Agent, Thread } from "../db/schema.js";
import { log } from "../logger.js";
import { PermanentError } from "../retry.js";
import {
  BROADCAST_NOTICE_MESSAGE,
  DELETED_PREFIX,
  FOLLOWUP_ALREADY_SENT_MESSAGE,
  FOLLOWUP_PROMPT_TIMEOUT_MS,
  FOLLOWUP_PROMPT_WINDOW_MS,
  FOLLOWUP_RELATED_MESSAGE,
  FOLLOWUP_SEPARATE_MESSAGE,
  REOPEN_PROMPT_TIMEOUT_MESSAGE,
  REOPEN_PROMPT_TIMEOUT_MS,
  struckThrough,
} from "../messages.js";
import {
  allFilesRelayed,
  answerHeldMessage,
  clearReopenPrompt,
  findHeldMessage,
  findRecentThreadByAuthor,
  findRelayedBySlack,
  holdMessage,
  findAgentBySlackUser,
  findThreadBySlack,
  hasLinkedSlackAccount,
  insertThread,
  isRelayedSlack,
  markEventSeen,
  markThreadDeleted,
  recordRelayed,
  setReopenPrompt,
  setWelcomeMessageTs,
} from "../store.js";
import { downloadSlackFiles, type SlackFileRef } from "./files.js";
import {
  buttonForStatus,
  FOLLOWUP_RELATED_ACTION_ID,
  FOLLOWUP_SEPARATE_ACTION_ID,
  followupPromptBlocks,
  KEEP_OPEN_ACTION_ID,
  messageBlocks,
  NOT_A_QUESTION_ACTION_ID,
  parseButtonValue,
  reopenPromptBlocks,
  RESOLVE_ACTION_ID,
  type ButtonAction,
} from "./blocks.js";
import { BRIDGE_METADATA_EVENT, deleteBridgeOnlyThread, postEphemeral, postEphemeralInThread, postSystemMessage } from "./post.js";
import { slackToChatwootText } from "./text.js";
import { getSlackProfile, messageStillExists } from "./users.js";

export const JOB_SLACK_MESSAGE = "slack_message";
export const JOB_SLACK_REACTION = "slack_reaction";
export const JOB_THREAD_DELETED = "slack_thread_deleted";
export const JOB_LINK_REQUIRED = "slack_link_required";
export const JOB_REOPEN_TIMEOUT = "slack_reopen_timeout";
export const JOB_BROADCAST_NOTICE = "slack_broadcast_notice";
export const JOB_FOLLOWUP_PROMPT = "slack_followup_prompt";
export const JOB_FOLLOWUP_TIMEOUT = "slack_followup_timeout";
export const JOB_REPLY_DELETED = "slack_reply_deleted";

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
  /** message_deleted: the ts of the message that was removed, and a copy of what it said. */
  deleted_ts?: string;
  previous_message?: { ts?: string; thread_ts?: string; user?: string };
}

/** A relayed Slack reply was deleted; take the Chatwoot copy down with it. */
export interface ReplyDeletedJob extends Record<string, unknown> {
  channel: string;
  conversationId: number;
  chatwootMessageId: number;
}

export interface ThreadDeletedJob extends Record<string, unknown> {
  channel: string;
  ts: string;
}

/** Tell an unlinked sender, privately, why their message went nowhere. */
export interface LinkRequiredJob extends Record<string, unknown> {
  channel: string;
  /** Thread to put the private notice in: the message's own ts when it started one. */
  threadTs: string;
  user: string;
}

/** Scheduled when the reopen prompt goes out; resolves the ticket again if nobody answered. */
export interface ReopenTimeoutJob extends Record<string, unknown> {
  channel: string;
  threadTs: string;
  /** Whose reply reopened the ticket, and who was asked about it. */
  user: string;
  /** The prompt this job belongs to; a newer prompt on the same thread supersedes it. */
  promptedAt: string;
}

/**
 * A new top-level question whose ticket is on hold while its sender says whether it really is a
 * new question. Carries the relay job so answering "separate" is just running it.
 */
export interface FollowupPromptJob extends Record<string, unknown> {
  channel: string;
  ts: string;
  user: string;
  priorThreadTs: string;
  message: SlackMessageJob;
}

/** Nobody answered a hold; the message goes through as a question of its own. */
export interface FollowupTimeoutJob extends Record<string, unknown> {
  channel: string;
  ts: string;
}

/** Someone replied with "Also send to #channel" ticked; ask them, privately, to remove the copy. */
export interface BroadcastNoticeJob extends Record<string, unknown> {
  channel: string;
  threadTs: string;
  user: string;
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
  // Someone deleted their question. Slack would happily accept further "replies" to it and show
  // them as ordinary channel posts, so stop bridging this thread entirely.
  if (msg.subtype === "message_deleted") {
    const deletedTs = msg.deleted_ts;
    if (!deletedTs) return "message_deleted without deleted_ts";
    const gone = await findThreadBySlack(ctx.db, msg.channel, deletedTs);
    if (gone) {
      if (gone.deletedAt) return "thread already marked deleted";
      await markThreadDeleted(ctx.db, gone.id);
      void ctx.retry.runOrEnqueue(JOB_THREAD_DELETED, { channel: msg.channel, ts: deletedTs } satisfies ThreadDeletedJob);
      return "thread parent deleted; bridging stopped";
    }
    // Not the question itself, so it was a reply. Mirror the deletion into Chatwoot if we relayed
    // it; a message we posted *from* Chatwoot is left alone, or deleting one there would bounce back.
    const record = await findRelayedBySlack(ctx.db, msg.channel, deletedTs);
    if (!record) return "deleted message was never relayed";
    if (record.direction !== "slack_to_chatwoot") return "deleted message came from Chatwoot";
    const parentTs = msg.previous_message?.thread_ts;
    const parent = parentTs ? await findThreadBySlack(ctx.db, msg.channel, parentTs) : undefined;
    if (!parent) return "deleted reply's thread is not mapped";
    if (!(await markEventSeen(ctx.db, eventId))) return "duplicate event";
    void ctx.retry.runOrEnqueue(JOB_REPLY_DELETED, {
      channel: msg.channel,
      conversationId: parent.chatwootConversationId,
      chatwootMessageId: record.chatwootMessageId,
    } satisfies ReplyDeletedJob);
    return null;
  }
  if (!RELAYABLE_SUBTYPES.has(msg.subtype)) return `subtype ${msg.subtype}`;
  if (msg.bot_id && msg.bot_id === bridge.botId) return "own bot message";
  if (msg.user && msg.user === bridge.botUserId) return "own bot user";
  if (msg.metadata?.event_type === BRIDGE_METADATA_EVENT) return "bridge-posted message";
  if (!msg.user) return "no user";
  if (!(await markEventSeen(ctx.db, eventId))) return "duplicate event";
  // "Also send to #channel" copies the reply into the channel proper, outside the thread. The
  // bridge can't delete someone else's message, so ask them to. The reply itself is relayed as
  // usual; this only concerns the copy Slack left in the channel.
  if (msg.subtype === "thread_broadcast" && msg.thread_ts && (await findThreadBySlack(ctx.db, msg.channel, msg.thread_ts))) {
    void ctx.retry.runOrEnqueue(JOB_BROADCAST_NOTICE, {
      channel: msg.channel,
      threadTs: msg.thread_ts,
      user: msg.user,
    } satisfies BroadcastNoticeJob);
  }
  // Bridges that require a linked account relay nothing from anyone who has not been through
  // /link. There is no anonymous route in that case; the sender is told privately instead.
  if (bridge.row.requireLink && !(await hasLinkedSlackAccount(ctx.db, msg.user))) {
    void ctx.retry.runOrEnqueue(JOB_LINK_REQUIRED, {
      channel: msg.channel,
      threadTs: msg.thread_ts ?? msg.ts,
      user: msg.user,
    } satisfies LinkRequiredJob);
    return "sender has not linked their slack account";
  }
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
  // Two questions in the channel minutes apart, from the same person, is nearly always a follow-up
  // that belonged in the first thread. Ask before opening a second ticket; nothing is relayed and
  // no welcome message goes out until they answer or the hold times out.
  const prior =
    bridge.row.followupPromptMessage && !isReplyTo(msg)
      ? await findRecentThreadByAuthor(ctx.db, msg.channel, msg.user, new Date(Date.now() - FOLLOWUP_PROMPT_WINDOW_MS))
      : undefined;
  if (prior && prior.slackThreadTs !== msg.ts) {
    void ctx.retry.runOrEnqueue(JOB_FOLLOWUP_PROMPT, {
      channel: msg.channel,
      ts: msg.ts,
      user: msg.user,
      priorThreadTs: prior.slackThreadTs,
      message: job,
    } satisfies FollowupPromptJob);
    return "held: may be a follow-up to a recent question";
  }
  // Fire and forget: the Slack request is already acked by Bolt; failures land in `retries`.
  void ctx.retry.runOrEnqueue(JOB_SLACK_MESSAGE, job);
  return null;
}

/** True for a thread reply, as opposed to a message that starts (or could start) a thread. */
function isReplyTo(msg: IncomingSlackMessage): boolean {
  return Boolean(msg.thread_ts && msg.thread_ts !== msg.ts);
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

function permanentIf4xx(err: unknown): never {
  if (err instanceof ChatwootHttpError && err.permanent) throw new PermanentError(err.message);
  throw err;
}

/**
 * A file the bridge uploaded with an agent's user token shows up as a normal user message; the
 * relayed_files row is written right after the upload, so wait briefly before deciding.
 */
export const SLACK_ECHO_GRACE_MS = 1500;

/** Clean up the orphaned thread in Slack, then tell the Chatwoot agents privately what happened. */
export async function noteThreadDeleted(ctx: AppContext, job: ThreadDeletedJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const thread = await findThreadBySlack(ctx.db, job.channel, job.ts);
  if (!thread) return;
  // What we know we posted, for when Slack will not list the thread at all.
  const ours = [thread.welcomeMessageTs, thread.statusMessageTs].filter((ts): ts is string => Boolean(ts));
  const removed = await deleteBridgeOnlyThread(bridge, job.channel, job.ts, ours).catch((err) => {
    log.warn("could not tidy up the orphaned thread", { channel: job.channel, ts: job.ts, error: err instanceof Error ? err.message : String(err) });
    return 0;
  });
  log.info("tidied up after a deleted thread", { channel: job.channel, ts: job.ts, removed });
  await bridge.chatwoot.createAgentMessage(
    thread.chatwootConversationId,
    "_The Slack message that started this conversation was deleted. Nothing further will be relayed to Slack._",
    { private: true },
  );
  log.info("thread parent deleted", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, channel: job.channel, ts: job.ts });
}

/**
 * Mark a deleted Slack reply as deleted in Chatwoot. The message is not removed: helpers usually
 * need to know what was said and that it is gone, so the text stays, struck through behind a
 * `[DELETED]` marker.
 */
export async function markDeletedReply(ctx: AppContext, job: ReplyDeletedJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  try {
    const message = (await bridge.chatwoot.listMessages(job.conversationId)).find((m) => m.id === job.chatwootMessageId);
    // Older than the page Chatwoot hands back, or gone already. Nothing to rewrite.
    if (!message) return void log.warn("could not find the Chatwoot message a deleted Slack reply belongs to", { messageId: job.chatwootMessageId });
    const content = message.content ?? "";
    if (content.startsWith(DELETED_PREFIX)) return; // a retry of a job that already ran
    await bridge.chatwoot.updateMessageContent(job.conversationId, job.chatwootMessageId, struckThrough(content));
  } catch (err) {
    permanentIf4xx(err);
  }
  log.info("marked a message deleted in Chatwoot after its Slack original went", {
    bridge: bridge.row.name,
    conversationId: job.conversationId,
    messageId: job.chatwootMessageId,
  });
}

/** Private nudge to someone whose message was held back for want of a linked account. */
export async function noteLinkRequired(ctx: AppContext, job: LinkRequiredJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const prompt = bridge.row.linkPromptMessage;
  if (!prompt) return; // the admin turned the notice off; the message is still held back
  const text = prompt.replaceAll("{link}", `${ctx.config.PUBLIC_URL}/link`);
  await postEphemeralInThread(bridge, job.channel, job.threadTs, job.user, text);
}

/** Private nudge to someone who also broadcast their thread reply to the channel. */
export async function noteThreadBroadcast(ctx: AppContext, job: BroadcastNoticeJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  await postEphemeralInThread(bridge, job.channel, job.threadTs, job.user, BROADCAST_NOTICE_MESSAGE);
}

/**
 * Park a possible follow-up and ask its sender which it is. The prompt goes in the channel rather
 * than the message's own thread: they have not opened that thread, and would not see it there.
 */
export async function askAboutFollowup(ctx: AppContext, job: FollowupPromptJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const prompt = bridge.row.followupPromptMessage;
  // The admin turned the check off between the message arriving and this running: let it through.
  if (!prompt) return void (await ctx.retry.runOrEnqueue(JOB_SLACK_MESSAGE, job.message));

  const held =
    (await holdMessage(ctx.db, {
      slackChannel: job.channel,
      slackTs: job.ts,
      slackUser: job.user,
      priorThreadTs: job.priorThreadTs,
      payload: job.message,
    })) ?? (await findHeldMessage(ctx.db, job.channel, job.ts));
  if (held?.answeredAt) return; // a retry of a hold that has already run its course

  await postEphemeral(bridge, job.channel, job.user, prompt, followupPromptBlocks(prompt, job.ts));
  await ctx.retry.schedule(JOB_FOLLOWUP_TIMEOUT, { channel: job.channel, ts: job.ts } satisfies FollowupTimeoutJob, FOLLOWUP_PROMPT_TIMEOUT_MS);
  log.info("held a possible follow-up", { bridge: bridge.row.name, channel: job.channel, ts: job.ts, user: job.user });
}

/**
 * The hold went unanswered. Silence is not a reason to drop someone's question, so treat it as a
 * new one and relay it. First-wins on the answer, so a click landing at the same moment still wins.
 */
export async function releaseUnansweredFollowup(ctx: AppContext, job: FollowupTimeoutJob): Promise<void> {
  const held = await findHeldMessage(ctx.db, job.channel, job.ts);
  if (!held || held.answeredAt) return;
  if (!(await answerHeldMessage(ctx.db, held.id, "timeout"))) return;
  log.info("releasing an unanswered follow-up hold", { channel: job.channel, ts: job.ts });
  await ctx.retry.runOrEnqueue(JOB_SLACK_MESSAGE, held.payload as SlackMessageJob);
}

/**
 * A click on the follow-up prompt. Returns what to show the clicker; "separate" releases the held
 * message, "related" drops it and asks them to move it into their earlier thread.
 */
export async function acceptFollowupAnswer(
  ctx: AppContext,
  click: { channel: string; ts: string; user: string; answer: "separate" | "related" },
): Promise<string> {
  const held = await findHeldMessage(ctx.db, click.channel, click.ts);
  if (!held) return "That message isn't waiting on an answer any more.";
  if (held.slackUser !== click.user) return "Only the person who sent that message can answer this.";
  const answered = await answerHeldMessage(ctx.db, held.id, click.answer);
  // Already decided: by the timeout, or by a double-click on the other button.
  if (!answered) return held.answer === "related" ? FOLLOWUP_RELATED_MESSAGE : FOLLOWUP_ALREADY_SENT_MESSAGE;
  if (click.answer === "related") {
    log.info("dropped a follow-up posted outside its thread", { channel: click.channel, ts: click.ts, user: click.user });
    return FOLLOWUP_RELATED_MESSAGE;
  }
  await ctx.retry.runOrEnqueue(JOB_SLACK_MESSAGE, held.payload as SlackMessageJob);
  return FOLLOWUP_SEPARATE_MESSAGE;
}

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
      if (thread?.deletedAt) return; // question was deleted before we got here
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
        // The question may have been deleted while we were talking to Chatwoot, in which case the
        // deletion event may have arrived before this thread row existed. Check both.
        const gone = Boolean((await findThreadBySlack(db, job.channel, job.ts))?.deletedAt) || !(await messageStillExists(bridge.slack, job.channel, job.ts));
        if (gone) {
          await markThreadDeleted(db, thread.id);
          void ctx.retry.runOrEnqueue(JOB_THREAD_DELETED, { channel: job.channel, ts: job.ts } satisfies ThreadDeletedJob);
          log.info("question was deleted before the thread got going", { channel: job.channel, ts: job.ts });
        } else if (bridge.row.welcomeMessage) {
          const blocks = messageBlocks(bridge.row.welcomeMessage, job.ts, buttonForStatus("open", bridge.row));
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
    if (thread.deletedAt) return;

    const agent = await findAgentBySlackUser(db, job.user);
    let messageId: number;
    if (agent?.chatwootAgentId) {
      // A helper has stepped in, so the ticket stays open whatever the reopen prompt was waiting for.
      if (thread.reopenPromptAt) await clearReopenPrompt(db, thread.id);
      // Linked agent: outgoing message attributed to them via their own API token.
      const apiToken = await agentChatwootToken(ctx, agent);
      const content = apiToken ? text : `**${author.name}:** ${text}`; // no token -> service agent posts, so name them
      const message = await chatwoot.createAgentMessage(thread.chatwootConversationId, content, { apiToken, attachments });
      messageId = message.id;
    } else {
      // Not an agent: post as the contact. If someone other than the OP replies, flag it.
      const content = job.user === thread.slackAuthorId ? text : `**[Not OP] ${author.name}:** ${text}`;
      const message = await chatwoot.createContactMessage(thread.chatwootContactSourceId, thread.chatwootConversationId, content, attachments, job.ts);
      messageId = message.id;
      // Chatwoot reopens a resolved conversation on any incoming message, so this reply just did.
      // Ask the sender, privately, whether they meant to. Only they can see or answer it.
      // A further reply while the question is still pending doesn't ask again — they have already
      // seen it, and the ticket is open either way — but it does restart the answer clock.
      if (bridge.row.reopenPromptMessage && (thread.lastStatus === "resolved" || thread.reopenPromptAt)) {
        const asked =
          thread.lastStatus !== "resolved" ||
          (await postEphemeralInThread(
            bridge,
            job.channel,
            thread.slackThreadTs,
            job.user,
            bridge.row.reopenPromptMessage,
            reopenPromptBlocks(bridge.row.reopenPromptMessage, thread.slackThreadTs),
          ).then(
            () => true,
            (err) => {
              log.warn("could not ask about the reopen", { channel: job.channel, error: err instanceof Error ? err.message : String(err) });
              return false;
            },
          ));
        // Nobody answers most of these, and an unanswered question is not a reason to keep a
        // ticket open: no answer means "no, I don't have a question".
        if (asked) {
          const promptedAt = await setReopenPrompt(db, thread.id, job.user);
          await ctx.retry.schedule(
            JOB_REOPEN_TIMEOUT,
            { channel: job.channel, threadTs: thread.slackThreadTs, user: job.user, promptedAt: promptedAt.toISOString() } satisfies ReopenTimeoutJob,
            REOPEN_PROMPT_TIMEOUT_MS,
          );
        }
      }
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
  const apiToken = await agentChatwootToken(ctx, agent);
  // Whichever way this arrived, the thread's state has now been decided by a human.
  if (thread.reopenPromptAt) await clearReopenPrompt(ctx.db, thread.id);

  try {
    if (job.action === "assign") {
      if (!agent?.chatwootAgentId) throw new PermanentError("assign by non-agent");
      await bridge.chatwoot.assignConversation(thread.chatwootConversationId, agent.chatwootAgentId, apiToken);
      log.info("assigned conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, agentId: agent.chatwootAgentId });
      return;
    }
    if (job.action === "reopen") {
      await reopenConversation(bridge, thread, agent, apiToken);
      log.info("reopened conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, by: job.user, via: job.via ?? "button" });
      return;
    }
    await resolveConversation(bridge, thread, agent, apiToken);
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

/**
 * The reopen prompt went unanswered. Treat silence as "no, I don't have a question" and resolve the
 * ticket again, exactly as the green button would have. Idempotent: the marker on the thread is the
 * only thing that authorizes this, and it is cleared the moment anyone answers or steps in.
 */
export async function resolveUnansweredReopen(ctx: AppContext, job: ReopenTimeoutJob): Promise<void> {
  const bridge = ctx.bridges.forChannel(job.channel);
  if (!bridge) throw new PermanentError(`no bridge for channel ${job.channel}`);
  const thread = await findThreadBySlack(ctx.db, job.channel, job.threadTs);
  if (!thread || thread.deletedAt) return;
  // Answered, superseded by a later prompt on the same thread, or cancelled by a helper.
  if (thread.reopenPromptAt?.getTime() !== new Date(job.promptedAt).getTime()) return;

  const refusal = await checkResolvePermission(ctx, thread, job.user);
  if (refusal) {
    // The sender could not have resolved it by clicking either, so leave it open for a helper.
    await clearReopenPrompt(ctx.db, thread.id);
    log.info("leaving an unanswered reopen alone", { reason: refusal, channel: job.channel, ts: job.threadTs, user: job.user });
    return;
  }

  const agent = await findAgentBySlackUser(ctx.db, job.user);
  try {
    await resolveConversation(bridge, thread, agent, await agentChatwootToken(ctx, agent));
  } catch (err) {
    permanentIf4xx(err); // still marked pending, so a retry will pick it up again
  }
  await clearReopenPrompt(ctx.db, thread.id);
  log.info("resolved conversation", { bridge: bridge.row.name, conversationId: thread.chatwootConversationId, by: job.user, via: "reopen timeout" });
  await postEphemeralInThread(bridge, job.channel, job.threadTs, job.user, REOPEN_PROMPT_TIMEOUT_MESSAGE).catch((err) =>
    log.warn("could not report the timed-out reopen", { channel: job.channel, error: err instanceof Error ? err.message : String(err) }),
  );
}

/** Register the retry-job handlers once per process. */
export function registerSlackJobs(ctx: AppContext): void {
  ctx.retry.register(JOB_SLACK_MESSAGE, (payload) => relaySlackMessage(ctx, payload as SlackMessageJob));
  ctx.retry.register(JOB_SLACK_REACTION, (payload) => applySlackReaction(ctx, payload as SlackReactionJob));
  ctx.retry.register(JOB_THREAD_DELETED, (payload) => noteThreadDeleted(ctx, payload as ThreadDeletedJob));
  ctx.retry.register(JOB_LINK_REQUIRED, (payload) => noteLinkRequired(ctx, payload as LinkRequiredJob));
  ctx.retry.register(JOB_REOPEN_TIMEOUT, (payload) => resolveUnansweredReopen(ctx, payload as ReopenTimeoutJob));
  ctx.retry.register(JOB_BROADCAST_NOTICE, (payload) => noteThreadBroadcast(ctx, payload as BroadcastNoticeJob));
  ctx.retry.register(JOB_FOLLOWUP_PROMPT, (payload) => askAboutFollowup(ctx, payload as unknown as FollowupPromptJob));
  ctx.retry.register(JOB_FOLLOWUP_TIMEOUT, (payload) => releaseUnansweredFollowup(ctx, payload as FollowupTimeoutJob));
  ctx.retry.register(JOB_REPLY_DELETED, (payload) => markDeletedReply(ctx, payload as ReplyDeletedJob));
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

  // Answers to the "did you mean to reopen this?" prompt. The prompt is ephemeral, so replacing it
  // through the response_url is both correct and private.
  app.action({ action_id: NOT_A_QUESTION_ACTION_ID }, async ({ ack, body, respond }) => {
    await ack();
    const b = body as unknown as { user?: { id?: string }; channel?: { id?: string }; trigger_id?: string; actions?: { value?: string }[] };
    const channel = b.channel?.id;
    const user = b.user?.id;
    const threadTs = b.actions?.[0]?.value;
    if (!channel || !user || !threadTs) return;
    const problem = await acceptResolveButton(ctx, { channel, threadTs, user, action: "resolve", triggerId: b.trigger_id ?? `${channel}:${threadTs}:${user}` });
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: problem ?? "Thanks, marking this as resolved again.",
    }).catch((err) => log.warn("could not answer the reopen prompt", { error: err instanceof Error ? err.message : String(err) }));
  });

  app.action({ action_id: KEEP_OPEN_ACTION_ID }, async ({ ack, body, respond }) => {
    await ack();
    const b = body as unknown as { user?: { id?: string }; channel?: { id?: string }; trigger_id?: string; actions?: { value?: string }[] };
    const channel = b.channel?.id;
    const user = b.user?.id;
    const threadTs = b.actions?.[0]?.value;
    if (!channel || !user || !threadTs) return;
    // Chatwoot has usually reopened it already, but the prompt may have timed out first and resolved
    // it again. Ask for a reopen either way: it only flips a ticket that really is resolved.
    const problem = await acceptResolveButton(ctx, { channel, threadTs, user, action: "reopen", triggerId: b.trigger_id ?? `${channel}:${threadTs}:${user}` });
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: problem ?? "Kept open. A helper will take a look.",
    }).catch((err) => log.warn("could not answer the reopen prompt", { error: err instanceof Error ? err.message : String(err) }));
  });

  // Answers to "is this a separate question?". Both buttons carry the held message's ts.
  for (const [actionId, answer] of [
    [FOLLOWUP_SEPARATE_ACTION_ID, "separate"],
    [FOLLOWUP_RELATED_ACTION_ID, "related"],
  ] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, respond }) => {
      await ack();
      const b = body as unknown as { user?: { id?: string }; channel?: { id?: string }; actions?: { value?: string }[] };
      const channel = b.channel?.id;
      const user = b.user?.id;
      const ts = b.actions?.[0]?.value;
      if (!channel || !user || !ts) return;
      const text = await acceptFollowupAnswer(ctx, { channel, ts, user, answer });
      await respond({ response_type: "ephemeral", replace_original: true, text }).catch((err) =>
        log.warn("could not answer the follow-up prompt", { error: err instanceof Error ? err.message : String(err) }),
      );
    });
  }

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
