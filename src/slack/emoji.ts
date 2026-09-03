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
 * Nearly every URL in a workspace shares `https://emoji.slack-edge.com/<team>/`, which is
 * most of each entry, so it is sent once and each value holds only what is left. The prefix
 * is the commonest root rather than one common to all: a single odd entry (Slack serves
 * `simple_smile` from its own CDN) would otherwise cost everyone else the saving. Anything
 * that does not start with the prefix keeps its absolute URL, which the client detects.
 */
export function splitPrefix(emoji: EmojiMap): { prefix: string; emoji: EmojiMap } {
  const roots = new Map<string, number>();
  for (const url of Object.values(emoji)) {
    const root = url.split("/").slice(0, 4).join("/") + "/"; // scheme, host, team
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }
  const [prefix = "", count = 0] = [...roots].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (prefix.length < 20 || count < 2) return { prefix: "", emoji };

  const trimmed: EmojiMap = {};
  for (const name of Object.keys(emoji)) {
    const url = emoji[name]!;
    trimmed[name] = url.startsWith(prefix) ? url.slice(prefix.length) : url;
  }
  return { prefix, emoji: trimmed };
}

/**
 * A 60k-emoji workspace is megabytes of JSON, far too much to hand every dashboard tab, so
 * the browser asks for matches instead of the list. Ranking: a name that starts with the
 * query wins, then the earliest match, then the shortest name.
 */
export function searchEmoji(emoji: EmojiMap, query: string, limit: number): EmojiMap {
  const q = query.toLowerCase().replace(/:/g, "").trim();
  const out: EmojiMap = {};
  if (!q) return out;

  const hits: { name: string; at: number }[] = [];
  for (const name of namesOf(emoji)) {
    const at = name.indexOf(q);
    if (at !== -1) hits.push({ name, at });
  }
  hits.sort((a, b) => a.at - b.at || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  for (const hit of hits.slice(0, limit)) out[hit.name] = emoji[hit.name]!;
  return out;
}

/** Keys of a 60k-entry map, kept per snapshot so a keystroke does not rebuild the array. */
const nameCache = new WeakMap<EmojiMap, string[]>();

function namesOf(emoji: EmojiMap): string[] {
  let names = nameCache.get(emoji);
  if (!names) {
    names = Object.keys(emoji);
    nameCache.set(emoji, names);
  }
  return names;
}

/** The named emoji only — what a rendered message needs to turn `:name:` into an image. */
export function lookupEmoji(emoji: EmojiMap, names: string[]): EmojiMap {
  const out: EmojiMap = {};
  for (const name of names) {
    const url = emoji[name.toLowerCase()];
    if (url) out[name.toLowerCase()] = url;
  }
  return out;
}
