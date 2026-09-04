import { describe, expect, it } from "vitest";
import { threads } from "../src/db/schema.js";
import { FOLLOWUP_RELATED_MESSAGE, FOLLOWUP_SEPARATE_MESSAGE } from "../src/messages.js";
import {
  acceptFollowupAnswer,
  acceptSlackMessage,
  askAboutFollowup,
  JOB_FOLLOWUP_PROMPT,
  JOB_FOLLOWUP_TIMEOUT,
  JOB_SLACK_MESSAGE,
  releaseUnansweredFollowup,
  relaySlackMessage,
  type IncomingSlackMessage,
} from "../src/slack/events.js";
import { findHeldMessage } from "../src/store.js";
import { flush, makeContext, type TestContext } from "./helpers.js";

const FIRST = "1700000000.000100";
const SECOND = "1700000000.000200";
const PROMPT = "Is this a separate question?";

async function setup(): Promise<TestContext> {
  const ctx = await makeContext({ bridge: { followupPromptMessage: PROMPT } });
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  ctx.retry.register(JOB_FOLLOWUP_PROMPT, (p) => askAboutFollowup(ctx, p as never));
  ctx.retry.register(JOB_FOLLOWUP_TIMEOUT, (p) => releaseUnansweredFollowup(ctx, p as never));
  return ctx;
}

const msg = (over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage => ({
  type: "message",
  channel: "C_HELP",
  ts: FIRST,
  user: "U_ALICE",
  text: "help me",
  ...over,
});

/** Their first question, asked `agoMs` ago. */
async function askedAlready(ctx: TestContext, agoMs: number, user = "U_ALICE"): Promise<void> {
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: FIRST,
    chatwootAccountId: 1,
    chatwootConversationId: 41,
    chatwootContactSourceId: `src-${user}`,
    slackAuthorId: user,
    createdAt: new Date(Date.now() - agoMs),
  });
}

describe("a second question minutes after the first", () => {
  it("holds the ticket and asks the sender which it is", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);

    expect(await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }))).toBe("held: may be a follow-up to a recent question");
    await flush();

    expect(ctx.chatwootMock.createConversation).not.toHaveBeenCalled();
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled(); // no welcome message either
    const [call] = ctx.slackMock.chat.postEphemeral.mock.calls;
    expect(call[0]).toMatchObject({ channel: "C_HELP", user: "U_ALICE", text: PROMPT });
    expect(call[0].thread_ts).toBeUndefined(); // in the channel, where they will see it
    expect(await findHeldMessage(ctx.db, "C_HELP", SECOND)).toMatchObject({ slackUser: "U_ALICE", priorThreadTs: FIRST, answeredAt: null });
  });

  it("opens the ticket when they say it is separate", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);
    await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }));
    await flush();

    expect(await acceptFollowupAnswer(ctx, { channel: "C_HELP", ts: SECOND, user: "U_ALICE", answer: "separate" })).toBe(FOLLOWUP_SEPARATE_MESSAGE);
    await flush();

    expect(ctx.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "also this", [], SECOND);
  });

  it("relays nothing and redirects them when it belongs to the earlier thread", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);
    await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }));
    await flush();

    expect(await acceptFollowupAnswer(ctx, { channel: "C_HELP", ts: SECOND, user: "U_ALICE", answer: "related" })).toBe(FOLLOWUP_RELATED_MESSAGE);
    await flush();

    expect(ctx.chatwootMock.createConversation).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.createContactMessage).not.toHaveBeenCalled();
  });

  it("lets the message through when nobody answers", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);
    await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }));
    await flush();

    await releaseUnansweredFollowup(ctx, { channel: "C_HELP", ts: SECOND });
    await flush();

    expect(ctx.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
    // A late click on the prompt neither opens a second ticket nor pretends the message was dropped.
    expect(await acceptFollowupAnswer(ctx, { channel: "C_HELP", ts: SECOND, user: "U_ALICE", answer: "related" })).toMatch(/already gone/);
    expect(ctx.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
  });

  it("only takes an answer from the person who sent the message", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);
    await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }));
    await flush();

    expect(await acceptFollowupAnswer(ctx, { channel: "C_HELP", ts: SECOND, user: "U_BOB", answer: "related" })).toMatch(/Only the person/);
    expect(await findHeldMessage(ctx.db, "C_HELP", SECOND)).toMatchObject({ answeredAt: null });
  });

  it("does not ask when their earlier question is older than the window", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 20 * 60_000);

    expect(await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "a new day, a new question" }))).toBeNull();
    await flush();

    expect(ctx.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("does not ask about someone else's recent question, or about a thread reply", async () => {
    const ctx = await setup();
    await askedAlready(ctx, 60_000);

    expect(await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, user: "U_BOB", text: "my own question" }))).toBeNull();
    expect(await acceptSlackMessage(ctx, "Ev3", msg({ ts: "1700000000.000300", thread_ts: FIRST, text: "still stuck" }))).toBeNull();
    await flush();

    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("stays out of the way when the bridge has the check turned off", async () => {
    const ctx = await makeContext();
    ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
    await askedAlready(ctx, 60_000);

    expect(await acceptSlackMessage(ctx, "Ev2", msg({ ts: SECOND, text: "also this" }))).toBeNull();
    await flush();

    expect(ctx.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
  });
});
