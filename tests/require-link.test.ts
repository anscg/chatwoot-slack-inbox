import { describe, expect, it } from "vitest";
import { encryptToken } from "../src/crypto.js";
import { relayed, threads } from "../src/db/schema.js";
import {
  acceptSlackMessage,
  JOB_LINK_REQUIRED,
  JOB_SLACK_MESSAGE,
  noteLinkRequired,
  relaySlackMessage,
  type IncomingSlackMessage,
} from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY, type BridgeOverrides, type TestContext } from "./helpers.js";

const TS = "1700000000.000100";

async function setup(bridge: BridgeOverrides): Promise<TestContext> {
  const ctx = await makeContext({ bridge });
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  ctx.retry.register(JOB_LINK_REQUIRED, (p) => noteLinkRequired(ctx, p as never));
  return ctx;
}

const msg = (over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage => ({
  type: "message",
  channel: "C_HELP",
  ts: TS,
  user: "U_ALICE",
  text: "help me",
  ...over,
});

describe("bridges that require a linked Slack account", () => {
  it("relays nothing from an unlinked sender and tells them privately", async () => {
    const ctx = await setup({ requireLink: true });

    expect(await acceptSlackMessage(ctx, "Ev1", msg())).toBe("sender has not linked their slack account");
    await flush();

    expect(ctx.chatwootMock.createConversation).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(threads)).toHaveLength(0);
    expect(await ctx.db.select().from(relayed)).toHaveLength(0);
    expect(ctx.slackMock.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C_HELP",
      thread_ts: TS,
      user: "U_ALICE",
      text: "Before you can post here, link your Slack account: https://bridge.test/link",
    });
  });

  it("holds replies back too, in the thread they were written in", async () => {
    const ctx = await setup({ requireLink: true });
    await ctx.db.insert(threads).values({
      slackChannel: "C_HELP",
      slackThreadTs: TS,
      chatwootAccountId: 1,
      chatwootConversationId: 42,
      chatwootContactSourceId: "src-U_ALICE",
      slackAuthorId: "U_ALICE",
    });

    expect(await acceptSlackMessage(ctx, "Ev2", msg({ ts: "1700000000.000300", thread_ts: TS, user: "U_BOB" }))).toBe(
      "sender has not linked their slack account",
    );
    await flush();

    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();
    expect(ctx.slackMock.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: TS, user: "U_BOB" }));
  });

  it("lets a linked sender through", async () => {
    const ctx = await setup({ requireLink: true });
    await upsertAgent(ctx.db, { slackUserId: "U_ALICE", slackUserTokenEnc: encryptToken("xoxp-alice", TEST_KEY) });

    expect(await acceptSlackMessage(ctx, "Ev1", msg())).toBeNull();
    await flush();

    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("a row without a Slack user token is not a link: an admin only pre-attached a Chatwoot token", async () => {
    const ctx = await setup({ requireLink: true });
    await upsertAgent(ctx.db, { slackUserId: "U_ALICE", chatwootAgentId: 7, chatwootApiTokenEnc: encryptToken("cw", TEST_KEY) });

    expect(await acceptSlackMessage(ctx, "Ev1", msg())).toBe("sender has not linked their slack account");
    await flush();
    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();
  });

  it("stays silent when the notice is blank, but still holds the message back", async () => {
    const ctx = await setup({ requireLink: true, linkPromptMessage: null });

    expect(await acceptSlackMessage(ctx, "Ev1", msg())).toBe("sender has not linked their slack account");
    await flush();

    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();
  });

  it("is off by default: an unlinked sender is relayed as before", async () => {
    const ctx = await setup({});

    expect(await acceptSlackMessage(ctx, "Ev1", msg())).toBeNull();
    await flush();

    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });
});
