import { describe, expect, it } from "vitest";
import { threads } from "../src/db/schema.js";
import { KEEP_OPEN_ACTION_ID, NOT_A_QUESTION_ACTION_ID, reopenPromptBlocks } from "../src/slack/blocks.js";
import { acceptResolveButton, acceptSlackMessage, JOB_SLACK_MESSAGE, JOB_SLACK_REACTION, applySlackReaction, relaySlackMessage, type IncomingSlackMessage } from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { encryptToken } from "../src/crypto.js";
import { flush, makeContext, TEST_KEY, type BridgeOverrides, type TestContext } from "./helpers.js";

const PARENT = "1700000000.000100";

async function setup(status: string | null, bridge?: BridgeOverrides): Promise<TestContext> {
  const ctx = await makeContext({ bridge });
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  ctx.retry.register(JOB_SLACK_REACTION, (p) => applySlackReaction(ctx, p as never));
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "src-U_ALICE",
    slackAuthorId: "U_ALICE",
    lastStatus: status,
  });
  return ctx;
}

const reply = (user = "U_ALICE"): IncomingSlackMessage => ({
  type: "message",
  channel: "C_HELP",
  ts: "1700000000.000300",
  thread_ts: PARENT,
  user,
  text: "thanks!",
});

describe("prompting about an accidental reopen", () => {
  it("asks the sender privately when their reply reopens a resolved ticket", async () => {
    const ctx = await setup("resolved");
    await acceptSlackMessage(ctx, "Ev1", reply());
    await flush();

    expect(ctx.slackMock.chat.postEphemeral).toHaveBeenCalledTimes(1);
    const args = ctx.slackMock.chat.postEphemeral.mock.calls[0]![0] as {
      channel: string;
      thread_ts: string;
      user: string;
      blocks: { elements?: { action_id?: string; style?: string; value?: string }[] }[];
    };
    expect(args).toMatchObject({ channel: "C_HELP", thread_ts: PARENT, user: "U_ALICE" });
    expect(args.blocks[1]?.elements).toMatchObject([
      { action_id: NOT_A_QUESTION_ACTION_ID, style: "primary", value: PARENT },
      { action_id: KEEP_OPEN_ACTION_ID, style: "danger", value: PARENT },
    ]);
    // The reply itself is still relayed.
    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledWith("src-U_ALICE", 42, "thanks!", [], "1700000000.000300");
  });

  it("stays quiet when the ticket was already open, or the prompt is switched off", async () => {
    const open = await setup("open");
    await acceptSlackMessage(open, "Ev1", reply());
    await flush();
    expect(open.slackMock.chat.postEphemeral).not.toHaveBeenCalled();

    const off = await setup("resolved", { reopenPromptMessage: null });
    await acceptSlackMessage(off, "Ev2", reply());
    await flush();
    expect(off.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("stays quiet for a linked agent, whose reply goes out as an agent message and never reopens", async () => {
    const ctx = await setup("resolved");
    await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, chatwootApiTokenEnc: encryptToken("agent-token", TEST_KEY) });
    await acceptSlackMessage(ctx, "Ev1", reply("U_AGENT"));
    await flush();
    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalled();
  });

  it("green resolves the ticket again; both answers are gated like any resolve", async () => {
    const ctx = await setup("resolved");
    // The asker may resolve through the public endpoint.
    expect(await acceptResolveButton(ctx, { channel: "C_HELP", threadTs: PARENT, user: "U_ALICE", action: "resolve", triggerId: "t1" })).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsContact).toHaveBeenCalledWith("src-U_ALICE", 42);

    // A bystander cannot, even though the prompt is only ever shown to the sender.
    expect(await acceptResolveButton(ctx, { channel: "C_HELP", threadTs: PARENT, user: "U_RANDO", action: "resolve", triggerId: "t2" })).toBe(
      "Only the person who asked or a helper can resolve this thread.",
    );
  });

  it("renders the configured text with both labels", () => {
    const blocks = reopenPromptBlocks("Did you mean to?", PARENT) as { text?: { text?: string }; elements?: { text?: { text?: string } }[] }[];
    expect(blocks[0]?.text?.text).toBe("Did you mean to?");
    expect(blocks[1]?.elements?.map((e) => e.text?.text)).toEqual(["No, I don't have a question", "I have a question, reopen"]);
  });
});
