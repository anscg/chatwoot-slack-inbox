import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { NextFunction, Request, Response, Router } from "express";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import { log } from "./logger.js";
import { EmojiCache, lookupEmoji, searchEmoji, splitPrefix, type EmojiMap, type EmojiSnapshot } from "./slack/emoji.js";

/**
 * Assets for Chatwoot's DASHBOARD_SCRIPTS hook: a browser script that teaches the agent
 * dashboard about this workspace's custom Slack emoji, and the emoji list it reads.
 * Both are unauthenticated — the dashboard loads them as an anonymous page — but they
 * expose nothing beyond emoji names and their already-public slack-edge image URLs.
 */
const SCRIPT_FILE = new URL("../public/slack-emoji.js", import.meta.url).pathname;

export function registerDashboardRoutes(router: Router, ctx: AppContext, cache: EmojiCache = new EmojiCache(ctx.hub)): void {
  const origins = allowedOrigins(ctx.config);

  router.get("/dashboard/slack-emoji.js", (req: Request, res: Response) => {
    allowOrigin(req, res, origins);
    if (!existsSync(SCRIPT_FILE)) {
      res.status(404).type("text/plain").send("// slack-emoji.js is missing from this deployment\n");
      return;
    }
    res.type("application/javascript").set("Cache-Control", "public, max-age=300").sendFile(SCRIPT_FILE);
  });

  // What the dashboard script actually calls: matches for what an agent typed, and the
  // handful of names a rendered message mentions. Both are small enough to answer per
  // keystroke, which the full list (megabytes at 60k emoji) never could be.
  router.get("/dashboard/slack-emoji/search", (req: Request, res: Response, next: NextFunction) => {
    allowOrigin(req, res, origins);
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);
    cache
      .get()
      .then((snapshot) => {
        send(res, splitPrefix(searchEmoji(snapshot.emoji, String(req.query.q ?? ""), limit)), snapshot.fetchedAt);
      })
      .catch(next);
  });

  router.get("/dashboard/slack-emoji/lookup", (req: Request, res: Response, next: NextFunction) => {
    allowOrigin(req, res, origins);
    const names = String(req.query.names ?? "").split(",").map((n) => n.trim()).filter(Boolean).slice(0, 200);
    cache
      .get()
      .then((snapshot) => {
        send(res, splitPrefix(lookupEmoji(snapshot.emoji, names)), snapshot.fetchedAt);
      })
      .catch(next);
  });

  /** The whole list. Nothing in the dashboard needs it; kept for debugging and export. */
  router.get("/dashboard/slack-emoji.json", (req: Request, res: Response, next: NextFunction) => {
    allowOrigin(req, res, origins);
    cache
      .get()
      .then((snapshot) => {
        const body = render(snapshot);
        res.set("Cache-Control", "public, max-age=3600").set("ETag", body.etag).type("application/json");
        res.set("Vary", "Origin, Accept-Encoding");
        if (req.headers["if-none-match"] === body.etag) {
          res.status(304).end();
          return;
        }
        if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
          res.set("Content-Encoding", "gzip").end(body.gzip);
          return;
        }
        res.end(body.json);
      })
      .catch((err: unknown) => {
        if (slackError(err) === "missing_scope") {
          log.warn("hub Slack app lacks emoji:read; reinstall it to serve custom emoji to Chatwoot");
          res.status(503).json({ error: "the hub Slack app needs the emoji:read scope; reinstall it from the manifest at /setup" });
          return;
        }
        next(err);
      });
  });
}

/**
 * The response body, built once per snapshot: a 10k-emoji workspace is close to a megabyte
 * of JSON, so it is gzipped here rather than per request (and there is no compression
 * middleware in front of this app).
 */
let rendered: { fetchedAt: number; json: string; gzip: Buffer; etag: string } | null = null;

function render(snapshot: EmojiSnapshot): { json: string; gzip: Buffer; etag: string } {
  if (rendered?.fetchedAt === snapshot.fetchedAt) return rendered;
  const { prefix, emoji } = splitPrefix(snapshot.emoji);
  const count = Object.keys(emoji).length;
  const json = JSON.stringify({ prefix, emoji, count, fetchedAt: new Date(snapshot.fetchedAt).toISOString() });
  rendered = { fetchedAt: snapshot.fetchedAt, json, gzip: gzipSync(json), etag: `W/"${snapshot.fetchedAt}-${count}"` };
  return rendered;
}

function send(res: Response, body: { prefix: string; emoji: EmojiMap }, fetchedAt: number): void {
  res.set("Cache-Control", "public, max-age=300").json({
    prefix: body.prefix,
    emoji: body.emoji,
    count: Object.keys(body.emoji).length,
    fetchedAt: new Date(fetchedAt).toISOString(),
  });
}

function slackError(err: unknown): string | undefined {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

/** The dashboard runs on the Chatwoot install; the bridge's own origin is allowed for testing. */
function allowedOrigins(config: Config): string[] {
  return [...new Set([config.CHATWOOT_BASE_URL, config.PUBLIC_URL].map((u) => new URL(u).origin))];
}

function allowOrigin(req: Request, res: Response, origins: string[]): void {
  const origin = req.headers.origin;
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Origin", origin && origins.includes(origin) ? origin : origins[0]!);
}
