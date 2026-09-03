import { createHmac } from "node:crypto";
import express from "express";
import { describe, expect, it } from "vitest";
import { encryptToken } from "../src/crypto.js";
import { threads } from "../src/db/schema.js";
import { registerSlackEvents, registerSlackJobs } from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY, type TestContext } from "./helpers.js";

const PARENT = "1700000000.000100";
const SECRET = "signing-secret";

/** Sign a body the way Slack does. */
function headers(body: string, contentType: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
  };
}

/** The real stack: Express -> ExpressReceiver -> Bolt -> our listeners. */
async function serve(ctx: TestContext) {
  const app = express();
  app.use("/slack/events/:slug", (req, res, next) => {
    const b = ctx.bridges.forSlug(String(req.params.slug));
    if (!b) return void res.status(404).end();
    b.receiver.app(req, res, next);
  });
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/slack/events/help`, close: () => server.close() };
}

async function setup() {
  const ctx = await makeContext({ bridge: false });
  (ctx.bridges as unknown as { opts: { onBoltApp: unknown } }).opts.onBoltApp = (app: Parameters<typeof registerSlackEvents>[0], id: number) =>
    registerSlackEvents(app, ctx, id);
  registerSlackJobs(ctx);
  const { addBridge } = await import("./helpers.js");
  await addBridge(ctx, {});
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "src-U_ALICE",
    slackAuthorId: "U_ALICE",
    welcomeMessageTs: "1700000000.000101",
  });
  await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, chatwootApiTokenEnc: encryptToken("agent-token", TEST_KEY) });
  return ctx;
}

function reactionEvent(reaction: string, user = "U_AGENT", ts = PARENT) {
  return JSON.stringify({
    type: "event_callback",
    event_id: `Ev${Math.random().toString(36).slice(2)}`,
    team_id: "T1",
    api_app_id: "A1",
    event: { type: "reaction_added", user, reaction, item: { type: "message", channel: "C_HELP", ts }, event_ts: "1700000000.000200" },
  });
}

describe("reaction_added over the real Bolt wiring", () => {
  it("resolves the conversation, and records the traffic", async () => {
    const ctx = await setup();
    const { url, close } = await serve(ctx);
    try {
      const body = reactionEvent("white_check_mark");
      const res = await fetch(url, { method: "POST", headers: headers(body, "application/json"), body });
      expect(res.status).toBe(200);
      await flush();
      expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", "agent-token");

      const { recentTraffic } = await import("../src/diagnostics.js");
      const kinds = recentTraffic(ctx.bridges.forChannel("C_HELP")!.row.id).map((t) => t.kind);
      expect(kinds).toContain("event:reaction_added");
      expect(kinds).toContain("decision");
    } finally {
      close();
    }
  });

  it("a custom emoji works when it matches the bridge's configuration", async () => {
    const ctx = await makeContext({ bridge: false });
    (ctx.bridges as unknown as { opts: { onBoltApp: unknown } }).opts.onBoltApp = (app: Parameters<typeof registerSlackEvents>[0], id: number) =>
      registerSlackEvents(app, ctx, id);
    registerSlackJobs(ctx);
    const { addBridge } = await import("./helpers.js");
    await addBridge(ctx, { reactionResolve: "ms-tick" });
    await ctx.db.insert(threads).values({
      slackChannel: "C_HELP",
      slackThreadTs: PARENT,
      chatwootAccountId: 1,
      chatwootConversationId: 42,
      chatwootContactSourceId: "src-U_ALICE",
      slackAuthorId: "U_ALICE",
    });
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7 });
    const { url, close } = await serve(ctx);
    try {
      const body = reactionEvent("ms-tick");
      expect((await fetch(url, { method: "POST", headers: headers(body, "application/json"), body })).status).toBe(200);
      await flush();
      expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", undefined);

      // The standard tick is then NOT configured, and is recorded as such.
      const other = reactionEvent("white_check_mark");
      await fetch(url, { method: "POST", headers: headers(other, "application/json"), body: other });
      await flush();
      const { recentTraffic } = await import("../src/diagnostics.js");
      expect(recentTraffic(ctx.bridges.forChannel("C_HELP")!.row.id).map((t) => t.detail)).toContain(":white_check_mark: -> unconfigured reaction");
    } finally {
      close();
    }
  });
});

describe("block_actions over the real Bolt wiring", () => {
  it("routes a Resolve click through to Chatwoot", async () => {
    const ctx = await setup();
    const { url, close } = await serve(ctx);
    try {
      const payload = JSON.stringify({
        type: "block_actions",
        user: { id: "U_AGENT" },
        channel: { id: "C_HELP" },
        trigger_id: "trig1",
        message: { ts: "1700000000.000101", thread_ts: PARENT },
        actions: [{ action_id: "chatwoot_bridge_resolve", value: `resolve:${PARENT}`, type: "button" }],
      });
      const body = `payload=${encodeURIComponent(payload)}`;
      const res = await fetch(url, { method: "POST", headers: headers(body, "application/x-www-form-urlencoded"), body });
      expect(res.status).toBe(200);
      await flush();
      expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", "agent-token");
      expect(ctx.slackMock.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: "C_HELP", thread_ts: PARENT, user: "U_AGENT", text: "Marked as resolved." }));
    } finally {
      close();
    }
  });
});
