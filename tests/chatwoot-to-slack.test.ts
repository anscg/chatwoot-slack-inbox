import express from "express";
import { describe, expect, it, vi } from "vitest";
import { classifyWebhook, JOB_CHATWOOT_MESSAGE, registerChatwootWebhook, relayChatwootMessage, type ChatwootMessageJob } from "../src/chatwoot/webhook.js";
import { encryptToken } from "../src/crypto.js";
import { agents, relayed, threads } from "../src/db/schema.js";
import { BRIDGE_METADATA_EVENT, resolvePostIdentity, setUserClientFactory } from "../src/slack/post.js";
import { acceptSlackMessage } from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY } from "./helpers.js";

const PARENT = "1700000000.000100";

async function setup() {
  const ctx = await makeContext();
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "src-U_ALICE",
    slackAuthorId: "U_ALICE",
  });
  ctx.retry.register(JOB_CHATWOOT_MESSAGE, (p) => relayChatwootMessage(ctx, p as ChatwootMessageJob, 0));
  return ctx;
}

function job(over: Partial<ChatwootMessageJob> = {}): ChatwootMessageJob {
  return {
    messageId: 500,
    accountId: 1,
    conversationId: 42,
    content: "Hi **there**, see [docs](https://d.test/x)",
    sender: { id: 7, name: "Agent Smith", avatar_url: "https://cw.test/smith.png" },
    attachments: [],
    ...over,
  };
}

describe("identity resolution", () => {
  it("posts as the agent's real account when they linked a Slack user token", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, slackUserTokenEnc: encryptToken("xoxp-agent", TEST_KEY) });
    const userPost = vi.fn(async () => ({ ok: true, ts: "1700000000.000900" }));
    const factory = vi.fn((_token: string) => ({ chat: { postMessage: userPost } }) as never);
    setUserClientFactory(factory);

    await relayChatwootMessage(ctx, job(), 0);

    expect(factory).toHaveBeenCalledWith("xoxp-agent");
    expect(userPost).toHaveBeenCalledTimes(1);
    const args = userPost.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({ channel: "C_HELP", thread_ts: PARENT, text: "Hi *there*, see <https://d.test/x|docs>" });
    expect(args).not.toHaveProperty("username");
    expect(args).not.toHaveProperty("as_user");
    expect((args.metadata as { event_type: string }).event_type).toBe(BRIDGE_METADATA_EVENT);
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(relayed)).toMatchObject([{ slackTs: "1700000000.000900", chatwootMessageId: 500, direction: "chatwoot_to_slack" }]);
  });

  it("falls back to the bot with the agent's name and avatar when there is no user token, and nudges them to link (once)", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7 }); // linked, but no Slack token
    await relayChatwootMessage(ctx, job(), 0);
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
    const args = ctx.slackMock.chat.postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({ username: "Agent Smith", icon_url: "https://cw.test/smith.png", thread_ts: PARENT });
    expect(args).not.toHaveProperty("as_user");
    // Private note in Chatwoot pointing at /link; never relayed to Slack (private), and only once per agent+conversation.
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledTimes(1);
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledWith(42, expect.stringContaining("https://bridge.test/link"), { private: true });
    await relayChatwootMessage(ctx, job({ messageId: 501 }), 0);
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("uses the bot for senders that are not linked at all", async () => {
    const ctx = await setup();
    expect(await resolvePostIdentity(ctx, { id: 99, name: "Unknown", avatar_url: "" })).toEqual({ kind: "bot", username: "Unknown", iconUrl: undefined });
  });
});

describe("echo-loop suppression (Chatwoot -> Slack)", () => {
  it("does not repost a Chatwoot message the bridge created from Slack", async () => {
    const ctx = await setup();
    await ctx.db.insert(relayed).values({ slackChannel: "C_HELP", slackTs: "1700000000.000300", chatwootMessageId: 500, direction: "slack_to_chatwoot" });
    await relayChatwootMessage(ctx, job(), 0);
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
  });

  it("is idempotent when the same webhook is delivered twice", async () => {
    const ctx = await setup();
    await relayChatwootMessage(ctx, job(), 0);
    await relayChatwootMessage(ctx, job(), 0);
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores Slack messages carrying the bridge's metadata marker (user-token posts have no bot_id)", async () => {
    const ctx = await setup();
    const r = await acceptSlackMessage(ctx, "Ev1", {
      type: "message",
      channel: "C_HELP",
      ts: "1700000000.000950",
      thread_ts: PARENT,
      user: "U_AGENT",
      text: "hi",
      metadata: { event_type: BRIDGE_METADATA_EVENT },
    });
    expect(r).toBe("bridge-posted message");
  });

  it("ignores conversations from other accounts even with the same display id", async () => {
    const ctx = await setup();
    await relayChatwootMessage(ctx, job({ accountId: 2 }), 0);
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe("webhook route", () => {
  function payload(over: Record<string, unknown> = {}) {
    return {
      event: "message_created",
      id: 501,
      content: "hello",
      message_type: "outgoing",
      private: false,
      account: { id: 1 },
      conversation: { id: 42 },
      sender: { id: 7, name: "Agent Smith", type: "user" },
      ...over,
    };
  }

  it("classifies only public outgoing message_created events", () => {
    expect(classifyWebhook(payload())).toHaveProperty("job");
    expect(classifyWebhook(payload({ message_type: "incoming" }))).toEqual({ skip: "message_type incoming" });
    expect(classifyWebhook(payload({ private: true }))).toEqual({ skip: "private note" });
    expect(classifyWebhook(payload({ event: "conversation_updated" }))).toEqual({ skip: "event conversation_updated" });
  });

  it("rejects a wrong secret and relays with the right one", async () => {
    const ctx = await setup();
    const app = express();
    app.use(express.json());
    registerChatwootWebhook(app, ctx);
    ctx.retry.register(JOB_CHATWOOT_MESSAGE, (p) => relayChatwootMessage(ctx, p as ChatwootMessageJob, 0));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const bad = await fetch(`http://127.0.0.1:${port}/webhooks/chatwoot/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) });
      expect(bad.status).toBe(404);
      const good = await fetch(`http://127.0.0.1:${port}/webhooks/chatwoot/${ctx.config.CHATWOOT_WEBHOOK_SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      expect(good.status).toBe(200);
      await flush();
      expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});

describe("dead user token", () => {
  it("falls back to the bot and unlinks the Slack token", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, slackUserTokenEnc: encryptToken("xoxp-dead", TEST_KEY) });
    setUserClientFactory(
      () =>
        ({
          chat: {
            postMessage: vi.fn(async () => {
              throw Object.assign(new Error("An API error occurred: token_revoked"), { code: "slack_webapi_platform_error", data: { error: "token_revoked" } });
            }),
          },
        }) as never,
    );
    await relayChatwootMessage(ctx, job(), 0);
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
    const [row] = await ctx.db.select().from(agents);
    expect(row!.slackUserTokenEnc).toBeNull();
  });
});
