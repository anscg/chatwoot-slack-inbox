import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyWebhook, deleteSlackCopy, JOB_CHATWOOT_DELETE } from "../src/chatwoot/webhook.js";
import { encryptToken } from "../src/crypto.js";
import { threads } from "../src/db/schema.js";
import { setUserClientFactory } from "../src/slack/post.js";
import {
  acceptSlackMessage,
  JOB_REPLY_DELETED,
  JOB_THREAD_DELETED,
  markDeletedReply,
  type IncomingSlackMessage,
} from "../src/slack/events.js";
import { recordRelayed, upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY, type TestContext } from "./helpers.js";

const PARENT = "1700000000.000100";
const REPLY = "1700000000.000200";

async function setup(): Promise<TestContext> {
  const ctx = await makeContext();
  ctx.retry.register(JOB_REPLY_DELETED, (p) => markDeletedReply(ctx, p as never));
  ctx.retry.register(JOB_CHATWOOT_DELETE, (p) => deleteSlackCopy(ctx, p as never));
  ctx.retry.register(JOB_THREAD_DELETED, async () => undefined); // its own tests cover the tidy-up
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "src-U_ALICE",
    slackAuthorId: "U_ALICE",
  });
  return ctx;
}

/** `threadTs: ""` stands for an event that arrived without the deleted message's thread. */
const deletion = (ts: string, threadTs = PARENT): IncomingSlackMessage => ({
  type: "message",
  subtype: "message_deleted",
  channel: "C_HELP",
  ts: "1700000000.000900",
  deleted_ts: ts,
  ...(threadTs ? { previous_message: { ts, thread_ts: threadTs, user: "U_ALICE" } } : {}),
});

afterEach(() => setUserClientFactory((token: string) => ({ token }) as never));

describe("a deleted Slack reply", () => {
  it("is marked deleted in Chatwoot, text kept and struck through", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 501, direction: "slack_to_chatwoot" });

    expect(await acceptSlackMessage(ctx, "Ev1", deletion(REPLY))).toBeNull();
    await flush();

    expect(ctx.chatwootMock.updateMessageContent).toHaveBeenCalledWith(42, 501, "[DELETED] ~~the reply~~");
  });

  it("strikes each line of a multi-line message, and leaves an already-marked one alone", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 501, direction: "slack_to_chatwoot" });
    ctx.chatwootMock.listMessages.mockResolvedValueOnce([{ id: 501, content: "one\n\ntwo", message_type: 0, conversation_id: 42 }]);

    await markDeletedReply(ctx, { channel: "C_HELP", conversationId: 42, chatwootMessageId: 501 });
    expect(ctx.chatwootMock.updateMessageContent).toHaveBeenCalledWith(42, 501, "[DELETED] ~~one~~\n\n~~two~~");

    // The retry queue may run the same job again; it must not stack markers.
    ctx.chatwootMock.listMessages.mockResolvedValueOnce([{ id: 501, content: "[DELETED] ~~one~~", message_type: 0, conversation_id: 42 }]);
    await markDeletedReply(ctx, { channel: "C_HELP", conversationId: 42, chatwootMessageId: 501 });
    expect(ctx.chatwootMock.updateMessageContent).toHaveBeenCalledTimes(1);
  });

  it("is left alone when it was the bridge's own copy of a Chatwoot message", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 501, direction: "chatwoot_to_slack" });

    expect(await acceptSlackMessage(ctx, "Ev1", deletion(REPLY))).toBe("deleted message came from Chatwoot");
    await flush();

    expect(ctx.chatwootMock.updateMessageContent).not.toHaveBeenCalled();
  });

  it("is ignored when we never relayed it, or when its thread is unknown", async () => {
    const ctx = await setup();
    expect(await acceptSlackMessage(ctx, "Ev1", deletion(REPLY))).toBe("deleted message was never relayed");

    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 501, direction: "slack_to_chatwoot" });
    expect(await acceptSlackMessage(ctx, "Ev2", deletion(REPLY, ""))).toBe("deleted reply's thread is not mapped");
    await flush();

    expect(ctx.chatwootMock.updateMessageContent).not.toHaveBeenCalled();
  });

  it("only goes through once when Slack delivers the event twice", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 501, direction: "slack_to_chatwoot" });

    expect(await acceptSlackMessage(ctx, "Ev1", deletion(REPLY))).toBeNull();
    expect(await acceptSlackMessage(ctx, "Ev1", deletion(REPLY))).toBe("duplicate event");
    await flush();

    expect(ctx.chatwootMock.updateMessageContent).toHaveBeenCalledTimes(1);
  });

  it("still stops the whole bridge when the question itself goes", async () => {
    const ctx = await setup();
    expect(await acceptSlackMessage(ctx, "Ev1", deletion(PARENT))).toBe("thread parent deleted; bridging stopped");
  });
});

describe("a message deleted in Chatwoot", () => {
  it("is recognised from the message_updated webhook", () => {
    const deleted = { event: "message_updated", id: 500, content_attributes: { deleted: true }, sender: { id: 7, name: "Agent Smith" } };
    expect(classifyWebhook(deleted)).toEqual({ deleteJob: { messageId: 500, sender: { id: 7, name: "Agent Smith", avatar_url: undefined } } });
    expect(classifyWebhook({ event: "message_updated", id: 500, content_attributes: {} })).toEqual({ skip: "message_updated that is not a deletion" });
  });

  it("takes the Slack copy down with it", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 500, direction: "chatwoot_to_slack" });

    await deleteSlackCopy(ctx, { messageId: 500, sender: null });

    expect(ctx.slackMock.chat.delete).toHaveBeenCalledWith({ channel: "C_HELP", ts: REPLY });
  });

  it("uses the agent's own token when the bot may not delete their message", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, slackUserTokenEnc: encryptToken("xoxp-agent", TEST_KEY) });
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 500, direction: "chatwoot_to_slack" });
    ctx.slackMock.chat.delete.mockRejectedValueOnce(Object.assign(new Error("cant_delete_message"), { data: { error: "cant_delete_message" } }));
    const userDelete = vi.fn(async () => ({ ok: true }));
    const factory = vi.fn((_token: string) => ({ chat: { delete: userDelete } }) as never);
    setUserClientFactory(factory);

    await deleteSlackCopy(ctx, { messageId: 500, sender: { id: 7, name: "Agent Smith" } });

    expect(factory).toHaveBeenCalledWith("xoxp-agent");
    expect(userDelete).toHaveBeenCalledWith({ channel: "C_HELP", ts: REPLY });
  });

  it("does not touch a Slack message that only came from Slack", async () => {
    const ctx = await setup();
    await recordRelayed(ctx.db, { slackChannel: "C_HELP", slackTs: REPLY, chatwootMessageId: 500, direction: "slack_to_chatwoot" });

    await deleteSlackCopy(ctx, { messageId: 500, sender: null });

    expect(ctx.slackMock.chat.delete).not.toHaveBeenCalled();
  });
});
