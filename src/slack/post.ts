import { WebClient, ErrorCode, type KnownBlock, type WebAPICallResult } from "@slack/web-api";
import { eq } from "drizzle-orm";
import type { Bridge } from "../bridges.js";
import type { AppContext } from "../context.js";
import { decryptToken } from "../crypto.js";
import { agents } from "../db/schema.js";
import { log } from "../logger.js";
import { findAgentByChatwootId } from "../store.js";

/** Marker attached to every message the bridge posts, so echoes are recognizable even without bot_id. */
export const BRIDGE_METADATA_EVENT = "chatwoot_bridge_relay";

export type PostIdentity =
  | { kind: "user"; slackUserId: string; token: string }
  | { kind: "bot"; username?: string; iconUrl?: string };

export interface ChatwootSenderRef {
  id?: number;
  name?: string;
  avatar_url?: string;
}

/**
 * Who should the Slack message appear to come from?
 *  - Chatwoot sender maps to a linked agent with a stored Slack user token -> post as them.
 *  - Otherwise -> bot, customized with the agent's Chatwoot name and avatar.
 */
export async function resolvePostIdentity(ctx: AppContext, sender: ChatwootSenderRef | null | undefined): Promise<PostIdentity> {
  const fallback: PostIdentity = { kind: "bot", username: sender?.name || undefined, iconUrl: sender?.avatar_url || undefined };
  if (!sender?.id) return fallback;
  const agent = await findAgentByChatwootId(ctx.db, sender.id);
  if (!agent?.slackUserTokenEnc) return fallback;
  try {
    return { kind: "user", slackUserId: agent.slackUserId, token: decryptToken(agent.slackUserTokenEnc, ctx.config.TOKEN_ENCRYPTION_KEY) };
  } catch (err) {
    log.error("could not decrypt slack user token; posting as bot", { agent: agent.slackUserId, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}

export interface PostArgs {
  channel: string;
  threadTs: string;
  text: string;
  identity: PostIdentity;
  /** Chatwoot message id, embedded as message metadata for echo detection. */
  chatwootMessageId: number;
}

/** Slack allows ~1 message/sec/channel. Serialize posts per channel with a 1s floor between them. */
class ChannelThrottle {
  private lastPost = new Map<string, number>();
  private chains = new Map<string, Promise<unknown>>();
  intervalMs = 1000;

  run<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.lastPost.get(channel) ?? 0) + this.intervalMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          return await fn();
        } finally {
          this.lastPost.set(channel, Date.now());
        }
      });
    this.chains.set(channel, next);
    return next;
  }
}

const throttle = new ChannelThrottle();

/** Tests set this to 0; production keeps Slack's ~1 msg/sec/channel floor. */
export function setPostIntervalMs(ms: number): void {
  throttle.intervalMs = ms;
}

/** Factory is overridable so tests can observe which token a client was built with. */
export let createUserClient = (token: string): WebClient => new WebClient(token, { retryConfig: { retries: 2 } });
export function setUserClientFactory(f: typeof createUserClient): void {
  createUserClient = f;
}

/**
 * Post into a Slack thread. Returns the new message ts.
 * Rate-limit errors propagate with `retryAfter` so the retry queue can back off accordingly.
 * A dead user token falls back to the bot and is removed from the agent row.
 */
export async function postToSlackThread(ctx: AppContext, bridge: Bridge, args: PostArgs): Promise<string> {
  const base = {
    channel: args.channel,
    thread_ts: args.threadTs,
    text: args.text,
    unfurl_links: false,
    unfurl_media: false,
    metadata: { event_type: BRIDGE_METADATA_EVENT, event_payload: { chatwoot_message_id: args.chatwootMessageId } },
  };

  return throttle.run(args.channel, async () => {
    if (args.identity.kind === "user") {
      const id = args.identity;
      try {
        return await postThreaded(createUserClient(id.token), base);
      } catch (err) {
        if (err instanceof ThreadGone) throw err;
        if (!isAuthError(err)) throw err;
        log.warn("slack user token rejected; unlinking and posting as bot", { slackUserId: id.slackUserId, error: (err as Error).message });
        await ctx.db.update(agents).set({ slackUserTokenEnc: null }).where(eq(agents.slackUserId, id.slackUserId));
      }
    }
    const bot: { username?: string; iconUrl?: string } = args.identity.kind === "bot" ? args.identity : {};
    return postThreaded(bridge.slack, {
      ...base,
      ...(bot.username ? { username: bot.username } : {}),
      ...(bot.iconUrl ? { icon_url: bot.iconUrl } : {}),
    });
  });
}

export interface UploadFile {
  data: Buffer;
  filename: string;
  title?: string;
}

export interface UploadArgs {
  channel: string;
  threadTs: string;
  /** Posted as the upload's initial comment (may be empty). */
  text: string;
  identity: PostIdentity;
  files: UploadFile[];
  chatwootMessageId: number;
}

export class SlackUploadUnavailable extends Error {}

/**
 * Upload files into a thread with `files.uploadV2`, as the agent when their user token has
 * `files:write`, otherwise as the bot (named in the comment, since uploads can't be customized).
 * Throws SlackUploadUnavailable when neither can upload, so the caller can fall back to links.
 * Returns the Slack file ids (for echo detection) and the share message ts when Slack reports it.
 */
export async function uploadToSlackThread(ctx: AppContext, bridge: Bridge, args: UploadArgs): Promise<{ fileIds: string[]; ts?: string }> {
  const uploads = args.files.map((f) => ({ file: f.data, filename: f.filename, title: f.title ?? f.filename }));
  const run = async (client: WebClient, comment: string) => {
    const res = (await client.files.uploadV2({
      channel_id: args.channel,
      thread_ts: args.threadTs,
      ...(comment ? { initial_comment: comment } : {}),
      file_uploads: uploads,
    })) as WebAPICallResult & { files?: { files?: { id?: string; shares?: unknown }[] }[] };
    const fileIds = (res.files ?? []).flatMap((r) => r.files ?? []).map((f) => f.id).filter((id): id is string => Boolean(id));
    return { fileIds, ts: await shareTs(client, fileIds[0], args.channel) };
  };

  return throttle.run(args.channel, async () => {
    if (args.identity.kind === "user") {
      const id = args.identity;
      try {
        return await run(createUserClient(id.token), args.text);
      } catch (err) {
        if (isAuthError(err)) {
          log.warn("slack user token rejected; unlinking and uploading as bot", { slackUserId: id.slackUserId, error: (err as Error).message });
          await ctx.db.update(agents).set({ slackUserTokenEnc: null }).where(eq(agents.slackUserId, id.slackUserId));
        } else if (isScopeError(err)) {
          log.warn("agent's slack token lacks files:write; uploading as bot (they should re-run /link)", { slackUserId: id.slackUserId });
        } else {
          throw err;
        }
      }
    }
    const who = args.identity.kind === "bot" && args.identity.username ? `*${args.identity.username}:*` : "";
    const comment = [who, args.text].filter(Boolean).join(args.text.includes("\n") ? "\n" : " ");
    try {
      return await run(bridge.slack, comment);
    } catch (err) {
      if (isScopeError(err)) throw new SlackUploadUnavailable(`bridge bot lacks files:write: ${(err as Error).message}`);
      throw err;
    }
  });
}

async function shareTs(client: WebClient, fileId: string | undefined, channel: string): Promise<string | undefined> {
  if (!fileId) return undefined;
  try {
    const info = (await client.files.info({ file: fileId })) as { file?: { shares?: { public?: Record<string, { ts?: string }[]>; private?: Record<string, { ts?: string }[]> } } };
    const shares = info.file?.shares;
    return shares?.public?.[channel]?.[0]?.ts ?? shares?.private?.[channel]?.[0]?.ts;
  } catch {
    return undefined;
  }
}

function isScopeError(err: unknown): boolean {
  const e = err as { code?: string; data?: { error?: string } };
  return e?.code === ErrorCode.PlatformError && ["missing_scope", "not_allowed_token_type", "no_permission"].includes(e.data?.error ?? "");
}

/** The thread this message belongs to is gone from Slack, so nothing more can be posted into it. */
export class ThreadGone extends Error {}

/**
 * Post into a thread, refusing to leak into the channel.
 *
 * When `thread_ts` points at a message that no longer exists (someone deleted their question,
 * possibly seconds after asking), Slack does not fail: it posts the message to the channel as a
 * normal top-level post. Detect that from the response and take the stray message back out.
 */
async function postThreaded(client: WebClient, args: Record<string, unknown> & { channel: string; thread_ts: string }): Promise<string> {
  const res = await client.chat.postMessage(args as never);
  const ts = tsOf(res);
  const posted = (res as { message?: { thread_ts?: string } }).message;
  if (posted && !posted.thread_ts) {
    log.warn("slack put our reply in the channel because the thread parent is gone; removing it", { channel: args.channel, threadTs: args.thread_ts });
    await client.chat.delete({ channel: args.channel, ts }).catch((err) =>
      log.error("could not remove the stray channel message", { channel: args.channel, ts, error: err instanceof Error ? err.message : String(err) }),
    );
    throw new ThreadGone(`thread parent ${args.thread_ts} no longer exists in ${args.channel}`);
  }
  return ts;
}

function tsOf(res: WebAPICallResult): string {
  const ts = (res as { ts?: string }).ts;
  if (!ts) throw new Error("chat.postMessage returned no ts");
  return ts;
}

function isAuthError(err: unknown): boolean {
  const e = err as { code?: string; data?: { error?: string } };
  if (e?.code !== ErrorCode.PlatformError) return false;
  return ["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed"].includes(e.data?.error ?? "");
}

/** A message from the bridge bot itself (welcome / status notices). Returns ts. */
export async function postSystemMessage(bridge: Bridge, channel: string, threadTs: string, text: string, blocks?: KnownBlock[]): Promise<string> {
  return throttle.run(channel, () =>
    postThreaded(bridge.slack, {
      channel,
      thread_ts: threadTs,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
      metadata: { event_type: BRIDGE_METADATA_EVENT, event_payload: { system: true } },
    }),
  );
}

/**
 * Stamp (or unstamp) an emoji on a message as the bridge bot. Slack's "already reacted" and
 * "no reaction to remove" answers are the desired end state, not failures. Needs `reactions:write`.
 */
export async function setBotReaction(bridge: Bridge, channel: string, ts: string, name: string, on: boolean): Promise<void> {
  try {
    if (on) await bridge.slack.reactions.add({ channel, timestamp: ts, name });
    else await bridge.slack.reactions.remove({ channel, timestamp: ts, name });
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    if (code === "already_reacted" || code === "no_reaction" || code === "message_not_found") return;
    throw err;
  }
}

/** Re-render the welcome message, e.g. to swap its button between Resolve and Reopen. */
export async function updateSystemMessage(bridge: Bridge, channel: string, ts: string, text: string, blocks: KnownBlock[]): Promise<void> {
  await bridge.slack.chat.update({ channel, ts, text, blocks });
}

/** A private notice in the channel itself, where the sender will see it without opening a thread. */
export async function postEphemeral(bridge: Bridge, channel: string, user: string, text: string, blocks?: KnownBlock[]): Promise<void> {
  await bridge.slack.chat.postEphemeral({ channel, user, text, ...(blocks ? { blocks } : {}) });
}

/**
 * Private, in-thread feedback to one person. `respond()` via an interaction's response_url lands in
 * the channel rather than the thread, so post the ephemeral message explicitly instead. Not
 * throttled: it is feedback for a click, and ephemerals don't broadcast.
 */
export async function postEphemeralInThread(
  bridge: Bridge,
  channel: string,
  threadTs: string,
  user: string,
  text: string,
  blocks?: KnownBlock[],
): Promise<void> {
  await bridge.slack.chat.postEphemeral({ channel, thread_ts: threadTs, user, text, ...(blocks ? { blocks } : {}) });
}

interface ReplyRef {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * After a thread's question is deleted, Slack keeps the thread alive with a "This message was
 * deleted" tombstone as its parent, leaving our welcome message stranded under it. If nothing but
 * the bridge's own messages remain, take them down too; the tombstone disappears on its own once
 * the last reply is gone. Anything a person wrote is left untouched, and its presence cancels the
 * cleanup entirely.
 */
export async function deleteBridgeOnlyThread(bridge: Bridge, channel: string, threadTs: string): Promise<number> {
  let messages: ReplyRef[];
  try {
    const res = await bridge.slack.conversations.replies({ channel, ts: threadTs, limit: 200 });
    messages = (res.messages ?? []) as ReplyRef[];
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    if (code === "thread_not_found" || code === "message_not_found" || code === "channel_not_found") return 0;
    throw err;
  }

  const remaining = messages.filter((m) => m.ts && m.ts !== threadTs && m.subtype !== "tombstone");
  if (remaining.length === 0) return 0;
  const isOurs = (m: ReplyRef) => m.bot_id === bridge.botId || m.user === bridge.botUserId;
  if (!remaining.every(isOurs)) return 0;

  let deleted = 0;
  for (const m of remaining) {
    await deleteSystemMessage(bridge, channel, m.ts!);
    deleted += 1;
  }
  return deleted;
}

/** Delete one of our own messages; a missing message is not an error. */
export async function deleteSystemMessage(bridge: Bridge, channel: string, ts: string): Promise<void> {
  try {
    await bridge.slack.chat.delete({ channel, ts });
  } catch (err) {
    const e = err as { data?: { error?: string } };
    if (e?.data?.error === "message_not_found" || e?.data?.error === "cant_delete_message") return;
    throw err;
  }
}
