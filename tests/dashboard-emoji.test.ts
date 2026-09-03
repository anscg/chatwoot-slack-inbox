import type { WebClient } from "@slack/web-api";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/context.js";
import { registerDashboardRoutes } from "../src/dashboard.js";
import { EmojiCache, fetchWorkspaceEmoji, splitPrefix } from "../src/slack/emoji.js";
import { testConfig } from "./helpers.js";

function slackWith(emoji: Record<string, string>, list = vi.fn(async () => ({ ok: true, emoji }))) {
  return { emoji: { list }, list } as unknown as WebClient & { list: typeof list };
}

async function withServer(hub: WebClient, fn: (base: string) => Promise<void>, cache?: EmojiCache) {
  const app = express();
  registerDashboardRoutes(app, { config: testConfig(), hub } as AppContext, cache);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.close();
  }
}

describe("workspace emoji", () => {
  it("follows alias chains and drops aliases to built-in emoji", async () => {
    const slack = slackWith({
      parrot: "https://emoji.slack-edge.com/T1/parrot/1.gif",
      birb: "alias:parrot",
      birb2: "alias:birb",
      grin: "alias:smile",
      loop: "alias:loop",
    });
    expect(await fetchWorkspaceEmoji(slack)).toEqual({
      parrot: "https://emoji.slack-edge.com/T1/parrot/1.gif",
      birb: "https://emoji.slack-edge.com/T1/parrot/1.gif",
      birb2: "https://emoji.slack-edge.com/T1/parrot/1.gif",
    });
  });

  it("asks Slack once per TTL and serves the cached snapshot in between", async () => {
    const slack = slackWith({ yay: "https://emoji.slack-edge.com/T1/yay/1.png" });
    const cache = new EmojiCache(slack, 1000);
    await Promise.all([cache.get(0), cache.get(0)]);
    await cache.get(500);
    expect(slack.list).toHaveBeenCalledTimes(1);
  });

  it("hands back the stale list at once and refreshes behind it", async () => {
    const list = vi.fn(async () => ({ ok: true, emoji: { yay: "https://emoji.slack-edge.com/T1/yay/1.png" } }));
    const cache = new EmojiCache(slackWith({}, list), 1000);
    await cache.get(0);
    list.mockResolvedValueOnce({ ok: true, emoji: { parrot: "https://emoji.slack-edge.com/T1/parrot/1.gif" } });

    // Nobody waits on Slack for a list we already have; the fresher one lands afterwards.
    expect((await cache.get(5000)).emoji).toHaveProperty("yay");
    expect(list).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect((await cache.get(5000)).emoji).toHaveProperty("parrot"));
  });

  it("keeps serving the last good list when a refresh fails", async () => {
    const list = vi.fn(async () => ({ ok: true, emoji: { yay: "https://emoji.slack-edge.com/T1/yay/1.png" } }));
    const cache = new EmojiCache(slackWith({}, list), 1000);
    expect((await cache.get(0)).emoji).toHaveProperty("yay");
    list.mockRejectedValueOnce(new Error("slack is down"));
    expect((await cache.get(5000)).emoji).toHaveProperty("yay");
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect((await cache.get(5000)).emoji).toHaveProperty("yay");
  });

  it("factors out the URL prefix the whole workspace shares", () => {
    expect(
      splitPrefix({
        parrot: "https://emoji.slack-edge.com/T0266FRGM/parrot/aa11.gif",
        yay: "https://emoji.slack-edge.com/T0266FRGM/yay/bb22.png",
      }),
    ).toEqual({
      prefix: "https://emoji.slack-edge.com/T0266FRGM/",
      emoji: { parrot: "parrot/aa11.gif", yay: "yay/bb22.png" },
    });
  });

  it("leaves URLs alone when they share nothing worth factoring out", () => {
    const mixed = { a: "https://a.example/1.png", b: "https://b.example/2.png" };
    expect(splitPrefix(mixed)).toEqual({ prefix: "", emoji: mixed });
  });
});

describe("dashboard script routes", () => {
  it("serves the emoji list to the Chatwoot origin", async () => {
    const slack = slackWith({ yay: "https://emoji.slack-edge.com/T1/yay/1.png" });
    await withServer(slack, async (base) => {
      const res = await fetch(`${base}/dashboard/slack-emoji.json`, { headers: { origin: "https://chatwoot.test" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://chatwoot.test");
      expect(await res.json()).toMatchObject({ count: 1, prefix: "", emoji: { yay: "https://emoji.slack-edge.com/T1/yay/1.png" } });
    });
  });

  it("does not hand the list to an unknown origin", async () => {
    await withServer(slackWith({}), async (base) => {
      const res = await fetch(`${base}/dashboard/slack-emoji.json`, { headers: { origin: "https://evil.test" } });
      expect(res.headers.get("access-control-allow-origin")).toBe("https://chatwoot.test");
    });
  });

  it("explains a missing emoji:read scope instead of failing opaquely", async () => {
    const list = vi.fn(async () => {
      throw Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } });
    });
    await withServer(slackWith({}, list as never), async (base) => {
      const res = await fetch(`${base}/dashboard/slack-emoji.json`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain("emoji:read");
    });
  });

  it("gzips the list and answers a revalidation with 304", async () => {
    const slack = slackWith({ yay: "https://emoji.slack-edge.com/T1/yay/1.png" });
    await withServer(slack, async (base) => {
      const res = await fetch(`${base}/dashboard/slack-emoji.json`);
      // fetch decodes gzip transparently, so the header is what proves it was compressed.
      expect(res.headers.get("content-encoding")).toBe("gzip");
      expect((await res.json()).count).toBe(1);

      const etag = res.headers.get("etag")!;
      expect(etag).toBeTruthy();
      const again = await fetch(`${base}/dashboard/slack-emoji.json`, { headers: { "if-none-match": etag } });
      expect(again.status).toBe(304);
    });
  });

  it("serves the browser script itself", async () => {
    await withServer(slackWith({}), async (base) => {
      const res = await fetch(`${base}/dashboard/slack-emoji.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toContain("slack-emoji.json");
    });
  });
});
