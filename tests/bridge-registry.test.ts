import express from "express";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { bridges } from "../src/db/schema.js";
import { registerSlackEvents } from "../src/slack/events.js";
import { addBridge, flush, makeContext } from "./helpers.js";

/** Sign a request the way Slack does, with a specific bridge's signing secret. */
function slackHeaders(secret: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig };
}

describe("per-bridge Slack apps", () => {
  it("routes events by slug and verifies with that bridge's own signing secret", async () => {
    const ctx = await makeContext({ bridge: false });
    const accepted: string[] = [];
    // Simulate index.ts: each Bolt app gets listeners; here we record which bridge saw what.
    (ctx.bridges as unknown as { opts: { onBoltApp: unknown } }).opts.onBoltApp = (app: Parameters<typeof registerSlackEvents>[0]) => {
      app.event("message", async ({ event }) => {
        accepted.push(`${(event as { channel: string }).channel}`);
      });
    };
    await addBridge(ctx, { name: "hcb", channel: "C_HCB" });
    await addBridge(ctx, { name: "ysws", channel: "C_YSWS" });

    const app = express();
    app.use("/slack/events/:slug", (req, res, next) => {
      const b = ctx.bridges.forSlug(String(req.params.slug));
      if (!b) return void res.status(404).end();
      b.receiver.app(req, res, next);
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T1",
      api_app_id: "A1",
      event: { type: "message", channel: "C_HCB", user: "U_A", text: "hi", ts: "1.0", channel_type: "channel" },
    });
    try {
      // Both bridges share the same secret in the helper, so use a wrong one to prove verification runs.
      const bad = await fetch(`http://127.0.0.1:${port}/slack/events/hcb`, { method: "POST", headers: slackHeaders("wrong-secret", body), body });
      expect(bad.status).toBe(401);
      const good = await fetch(`http://127.0.0.1:${port}/slack/events/hcb`, { method: "POST", headers: slackHeaders("signing-secret", body), body });
      expect(good.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/slack/events/nope`, { method: "POST", headers: slackHeaders("signing-secret", body), body })).status).toBe(404);
      await flush();
      expect(accepted).toEqual(["C_HCB"]);
    } finally {
      server.close();
    }
  });

  it("uses each bridge's own bot identity for self-echo checks", async () => {
    const ctx = await makeContext();
    const b = ctx.bridges.forChannel("C_HELP")!;
    expect(b.botId).toBe("B_OURS");
    expect(b.botUserId).toBe("U_BOT");
    expect(b.botToken).toBe("xoxb-bridge-bot");
  });

  it("reuses Bolt apps across reloads unless the Slack secrets change, and drops disabled bridges from channel lookup", async () => {
    const ctx = await makeContext();
    const before = ctx.bridges.forChannel("C_HELP")!;
    await ctx.bridges.reload();
    expect(ctx.bridges.forChannel("C_HELP")!.bolt).toBe(before.bolt);

    await ctx.db.update(bridges).set({ enabled: false });
    await ctx.bridges.reload();
    expect(ctx.bridges.forChannel("C_HELP")).toBeUndefined();
    expect(ctx.bridges.forSlug("help")).toBeDefined();
    expect(ctx.bridges.forSlug("help")!.row.enabled).toBe(false);
  });

  it("caches bot ids from the row and only calls auth.test when missing", async () => {
    const ctx = await makeContext();
    const authTest = vi.fn(async () => ({ botId: "B_FRESH", botUserId: "U_FRESH" }));
    (ctx.bridges as unknown as { opts: { authTest: unknown } }).opts.authTest = authTest;
    await ctx.db.update(bridges).set({ slackBotId: "B_CACHED", slackBotUserId: "U_CACHED", slackSigningSecretEnc: ctx.bridges.forChannel("C_HELP")!.row.slackSigningSecretEnc + "" });
    await ctx.bridges.reload();
    // Row changed (bot ids) -> rebuilt, but from cached ids, no network.
    expect(ctx.bridges.forChannel("C_HELP")!.botId).toBe("B_CACHED");
    expect(authTest).not.toHaveBeenCalled();
  });
});
