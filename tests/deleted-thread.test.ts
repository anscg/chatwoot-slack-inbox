import { describe, expect, it } from "vitest";
import { applyChatwootStatus, relayChatwootMessage, type ChatwootMessageJob } from "../src/chatwoot/webhook.js";
import { threads } from "../src/db/schema.js";
import { acceptSlackMessage, JOB_SLACK_MESSAGE, JOB_THREAD_DELETED, noteThreadDeleted, relaySlackMessage, type IncomingSlackMessage } from "../src/slack/events.js";
import { flush, makeContext, type TestContext } from "./helpers.js";

const PARENT = "1700000000.000100";

function post(over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return { type: "message", channel: "C_HELP", ts: PARENT, user: "U_ALICE", text: "help me", ...over };
}

function deletion(ts = PARENT): IncomingSlackMessage {
  return { type: "message", subtype: "message_deleted", channel: "C_HELP", ts: "1700000000.000200", deleted_ts: ts };
}

async function setup(): Promise<TestContext> {
  const ctx = await makeContext();
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  ctx.retry.register(JOB_THREAD_DELETED, (p) => noteThreadDeleted(ctx, p as never));
  return ctx;
}

describe("a deleted question", () => {
  it("stops bridging the thread and tells the agents privately", async () => {
    const ctx = await setup();
    await acceptSlackMessage(ctx, "Ev1", post());
    await flush();
    expect((await ctx.db.select().from(threads))[0]!.chatwootConversationId).toBe(42);

    expect(await acceptSlackMessage(ctx, "Ev2", deletion())).toBe("thread parent deleted; bridging stopped");
    await flush();
    expect((await ctx.db.select().from(threads))[0]!.deletedAt).toBeInstanceOf(Date);
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledWith(42, expect.stringContaining("was deleted"), { private: true });

    // A second delivery of the same deletion is a no-op.
    expect(await acceptSlackMessage(ctx, "Ev3", deletion())).toBe("thread already marked deleted");
  });

  it("ignores later replies in Slack and later agent replies from Chatwoot", async () => {
    const ctx = await setup();
    await acceptSlackMessage(ctx, "Ev1", post());
    await flush();
    await acceptSlackMessage(ctx, "Ev2", deletion());
    await flush();
    ctx.chatwootMock.createContactMessage.mockClear();
    ctx.slackMock.chat.postMessage.mockClear();

    await acceptSlackMessage(ctx, "Ev4", post({ ts: "1700000000.000300", thread_ts: PARENT, text: "still there?" }));
    await flush();
    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();

    await relayChatwootMessage(
      ctx,
      { messageId: 900, accountId: 1, conversationId: 42, content: "hello?", sender: { id: 7, name: "Agent" }, attachments: [] } satisfies ChatwootMessageJob,
      0,
    );
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
  });

  it("stays silent when the conversation is later resolved or reopened in Chatwoot", async () => {
    const ctx = await setup();
    await acceptSlackMessage(ctx, "Ev1", post());
    await flush();
    await acceptSlackMessage(ctx, "Ev2", deletion());
    await flush();
    ctx.slackMock.chat.postMessage.mockClear();

    await applyChatwootStatus(ctx, { conversationId: 42, status: "resolved", accountId: 1 });
    await applyChatwootStatus(ctx, { conversationId: 42, status: "open", accountId: 1 });

    // No notice, no emoji stamp on a message that no longer exists, no attempt to edit the welcome.
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
    expect(ctx.slackMock.reactions.add).not.toHaveBeenCalled();
    expect(ctx.slackMock.reactions.remove).not.toHaveBeenCalled();
    expect(ctx.slackMock.chat.update).not.toHaveBeenCalled();
  });

  it("skips the welcome when the question vanished mid-relay, but still records the question in Chatwoot", async () => {
    const ctx = await setup();
    // Slack says the message is no longer there by the time we go to greet.
    ctx.slackMock.conversations.history.mockResolvedValueOnce({ ok: true, messages: [] });

    await relaySlackMessage(ctx, { channel: "C_HELP", ts: PARENT, user: "U_ALICE", text: "help me" }, 0);
    await flush();

    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
    expect((await ctx.db.select().from(threads))[0]!.deletedAt).toBeInstanceOf(Date);
    // The question itself is still relayed, and the agents get told why it went quiet.
    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledWith("src-U_ALICE", 42, "help me", [], PARENT);
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledWith(42, expect.stringContaining("was deleted"), { private: true });
  });

  it("still greets normally when the question is alive", async () => {
    const ctx = await setup();
    await relaySlackMessage(ctx, { channel: "C_HELP", ts: PARENT, user: "U_ALICE", text: "help me" }, 0);
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(ctx.slackMock.conversations.history).toHaveBeenCalledWith({ channel: "C_HELP", latest: PARENT, oldest: PARENT, inclusive: true, limit: 1 });
  });
});

describe("Slack silently unthreading a reply", () => {
  it("removes the stray channel message and marks the thread dead instead of retrying", async () => {
    const ctx = await setup();
    await ctx.db.insert(threads).values({
      slackChannel: "C_HELP",
      slackThreadTs: PARENT,
      chatwootAccountId: 1,
      chatwootConversationId: 42,
      chatwootContactSourceId: "src-U_ALICE",
      slackAuthorId: "U_ALICE",
    });
    // Slack accepts the post but returns a message with no thread_ts: it went to the channel.
    ctx.slackMock.chat.postMessage.mockResolvedValueOnce({ ok: true, ts: "1700000000.000900", message: { text: "hi" } });

    await relayChatwootMessage(
      ctx,
      { messageId: 901, accountId: 1, conversationId: 42, content: "are you there?", sender: { id: 7, name: "Agent" }, attachments: [] },
      0,
    );

    expect(ctx.slackMock.chat.delete).toHaveBeenCalledWith({ channel: "C_HELP", ts: "1700000000.000900" });
    expect((await ctx.db.select().from(threads))[0]!.deletedAt).toBeInstanceOf(Date);
    expect(await ctx.db.select().from((await import("../src/db/schema.js")).retries)).toHaveLength(0);
  });
});
