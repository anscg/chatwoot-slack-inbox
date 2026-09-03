import { WebClient, ErrorCode, type WebAPICallResult } from "@slack/web-api";
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

  run<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.lastPost.get(channel) ?? 0) + 1000 - Date.now();
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
        const res = await createUserClient(id.token).chat.postMessage(base);
        return tsOf(res);
      } catch (err) {
        if (!isAuthError(err)) throw err;
        log.warn("slack user token rejected; unlinking and posting as bot", { slackUserId: id.slackUserId, error: (err as Error).message });
        await ctx.db.update(agents).set({ slackUserTokenEnc: null }).where(eq(agents.slackUserId, id.slackUserId));
      }
    }
    const bot: { username?: string; iconUrl?: string } = args.identity.kind === "bot" ? args.identity : {};
    const res = await bridge.slack.chat.postMessage({
      ...base,
      ...(bot.username ? { username: bot.username } : {}),
      ...(bot.iconUrl ? { icon_url: bot.iconUrl } : {}),
    });
    return tsOf(res);
  });
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
