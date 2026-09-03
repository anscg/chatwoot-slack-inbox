import type { WebClient } from "@slack/web-api";
import { log } from "../logger.js";

/** name -> image URL. Only custom emoji; Slack's built-ins are Unicode and need no help. */
export type EmojiMap = Record<string, string>;

export interface EmojiSnapshot {
  emoji: EmojiMap;
  fetchedAt: number;
}

const ALIAS = "alias:";

/**
 * The workspace's custom emoji, with `alias:` chains followed to the image they end at.
 * Aliases pointing at a built-in (`alias:smile`) resolve to nothing and are dropped.
 */
export async function fetchWorkspaceEmoji(slack: WebClient): Promise<EmojiMap> {
  const res = await slack.emoji.list({});
  const raw = (res.emoji ?? {}) as EmojiMap;
  const out: EmojiMap = {};
  for (const name of Object.keys(raw)) {
    const url = resolve(raw, name, 0);
    if (url) out[name] = url;
  }
  return out;
}

function resolve(raw: EmojiMap, name: string, depth: number): string | null {
  const value = raw[name];
  if (!value || depth > 5) return null;
  if (value.startsWith(ALIAS)) return resolve(raw, value.slice(ALIAS.length), depth + 1);
  return /^https?:\/\//.test(value) ? value : null;
}

/** A big workspace has ~10k custom emoji, and the set changes by the day, not the minute. */
export const EMOJI_TTL_MS = 24 * 60 * 60_000;

/**
 * Memoised emoji list. Only the very first request waits on Slack; once there is a
 * snapshot it is served immediately and a stale one is refreshed in the background, so
 * a 10k-entry `emoji.list` never sits in front of a dashboard load. A failed refresh
 * leaves the last good snapshot in place.
 */
export class EmojiCache {
  private snapshot: EmojiSnapshot | null = null;
  private inflight: Promise<EmojiSnapshot> | null = null;

  constructor(
    private readonly slack: WebClient,
    private readonly ttlMs = EMOJI_TTL_MS,
  ) {}

  async get(now = Date.now()): Promise<EmojiSnapshot> {
    if (this.snapshot) {
      if (now - this.snapshot.fetchedAt >= this.ttlMs) void this.refresh(now).catch(() => undefined);
      return this.snapshot;
    }
    return this.refresh(now);
  }

  private refresh(now: number): Promise<EmojiSnapshot> {
    this.inflight ??= fetchWorkspaceEmoji(this.slack)
      .then((emoji) => {
        this.snapshot = { emoji, fetchedAt: now };
        return this.snapshot;
      })
      .catch((err: unknown) => {
        log.warn("slack emoji refresh failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/**
 * Every URL in a workspace shares `https://emoji.slack-edge.com/<team>/`, which is most of
 * each entry, so it is sent once and the map holds what is left. Worth roughly half the
 * payload before gzip gets to it.
 */
export function splitPrefix(emoji: EmojiMap): { prefix: string; emoji: EmojiMap } {
  const urls = Object.values(emoji);
  if (urls.length < 2) return { prefix: "", emoji };

  let prefix = urls[0]!;
  for (const url of urls) {
    let i = 0;
    while (i < prefix.length && i < url.length && prefix[i] === url[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  if (prefix.length < 20) return { prefix: "", emoji };

  const trimmed: EmojiMap = {};
  for (const name of Object.keys(emoji)) trimmed[name] = emoji[name]!.slice(prefix.length);
  return { prefix, emoji: trimmed };
}
