import { describe, expect, it } from "vitest";
import { threads } from "../src/db/schema.js";
import { BROADCAST_NOTICE_MESSAGE } from "../src/messages.js";
import {
  acceptSlackMessage,
  JOB_BROADCAST_NOTICE,
  JOB_SLACK_MESSAGE,
  noteThreadBroadcast,
  relaySlackMessage,
  type IncomingSlackMessage,
} from "../src/slack/events.js";
import { flush, makeContext, type TestContext } from "./helpers.js";

const PARENT = "1700000000.000100";
const REPLY = "1700000000.000200";

async function setup(): Promise<TestContext> {
  const ctx = await makeContext();
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  ctx.retry.register(JOB_BROADCAST_NOTICE, (p) => noteThreadBroadcast(ctx, p as never));
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

const reply = (over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage => ({
  type: "message",
  channel: "C_HELP",
  ts: REPLY,
  thread_ts: PARENT,
  user: "U_ALICE",
  text: "still stuck",
  ...over,
});

describe("replies that were also sent to the channel", () => {
  it("relays the reply and asks the sender to delete the channel copy", async () => {
    const ctx = await setup();

    expect(await acceptSlackMessage(ctx, "Ev1", reply({ subtype: "thread_broadcast" }))).toBeNull();
    await flush();

    expect(ctx.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
    expect(ctx.slackMock.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C_HELP",
      thread_ts: PARENT,
      user: "U_ALICE",
      text: BROADCAST_NOTICE_MESSAGE,
    });
  });

  it("says nothing about an ordinary thread reply", async () => {
    const ctx = await setup();

    expect(await acceptSlackMessage(ctx, "Ev1", reply())).toBeNull();
    await flush();

    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("ignores a broadcast in a thread the bridge does not know", async () => {
    const ctx = await setup();

    expect(await acceptSlackMessage(ctx, "Ev1", reply({ subtype: "thread_broadcast", thread_ts: "1700000000.999999" }))).toBeNull();
    await flush();

    expect(ctx.slackMock.chat.postEphemeral).not.toHaveBeenCalled();
  });
});
