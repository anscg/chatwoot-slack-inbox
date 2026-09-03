import { describe, expect, it } from "vitest";
import { relayed, threads, retries } from "../src/db/schema.js";
import { encryptToken } from "../src/crypto.js";
import { acceptSlackMessage, JOB_SLACK_MESSAGE, relaySlackMessage, type IncomingSlackMessage } from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY } from "./helpers.js";

function msg(over: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return { type: "message", channel: "C_HELP", ts: "1700000000.000100", user: "U_ALICE", text: "help me <@U_BOB> &amp; co", ...over };
}

async function setup() {
  const ctx = await makeContext();
  ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  return ctx;
}

describe("Slack -> Chatwoot", () => {
  it("creates contact, conversation and message for a top-level post", async () => {
    const bridge = await setup();
    expect(await acceptSlackMessage(bridge, "Ev1", msg())).toBeNull();
    await flush();

    expect(bridge.chatwootMock.upsertContact).toHaveBeenCalledWith({
      identifier: "U_ALICE",
      name: "Name U_ALICE",
      email: "u_alice@example.com",
      avatarUrl: "https://avatars.test/U_ALICE.png",
    });
    expect(bridge.chatwootMock.createConversation).toHaveBeenCalledWith("src-U_ALICE");
    // Welcome message from the bot in the new thread.
    expect(bridge.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);
    const welcome = bridge.slackMock.chat.postMessage.mock.calls[0]![0] as { channel: string; thread_ts: string; text: string; blocks: { type: string; elements?: { action_id?: string; value?: string; text?: { text?: string } }[] }[] };
    expect(welcome).toMatchObject({ channel: "C_HELP", thread_ts: "1700000000.000100", text: expect.stringContaining("helper will be with you soon") });
    // ...with a Resolve button whose value carries the thread ts.
    const actions = welcome.blocks.find((b) => b.type === "actions");
    expect(actions?.elements?.[0]).toMatchObject({ action_id: "chatwoot_bridge_resolve", value: "1700000000.000100", text: { text: "Resolve" } });
    // Contact refreshed after creation so the Slack avatar/name win over Gravatar or stale data.
    expect(bridge.chatwootMock.updateContact).toHaveBeenCalledWith(1, { name: "Name U_ALICE", avatarUrl: "https://avatars.test/U_ALICE.png" });
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenCalledWith("src-U_ALICE", 42, "help me @Name U_BOB & co", [], "1700000000.000100");

    const t = await bridge.db.select().from(threads);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ slackChannel: "C_HELP", slackThreadTs: "1700000000.000100", chatwootAccountId: 1, chatwootConversationId: 42, slackAuthorId: "U_ALICE" });
    const r = await bridge.db.select().from(relayed);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ slackTs: "1700000000.000100", chatwootMessageId: 100, direction: "slack_to_chatwoot" });
  });

  it("dedupes on event_id: a Slack retry does not create a second conversation", async () => {
    const bridge = await setup();
    expect(await acceptSlackMessage(bridge, "Ev1", msg())).toBeNull();
    expect(await acceptSlackMessage(bridge, "Ev1", msg())).toBe("duplicate event");
    await flush();
    expect(bridge.chatwootMock.createConversation).toHaveBeenCalledTimes(1);
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores messages from unbridged channels, our own bot, and non-relayable subtypes", async () => {
    const bridge = await setup();
    expect(await acceptSlackMessage(bridge, "Ev1", msg({ channel: "C_OTHER" }))).toBe("unbridged channel");
    expect(await acceptSlackMessage(bridge, "Ev2", msg({ bot_id: "B_OURS", user: undefined }))).toBe("own bot message");
    expect(await acceptSlackMessage(bridge, "Ev3", msg({ user: "U_BOT" }))).toBe("own bot user");
    expect(await acceptSlackMessage(bridge, "Ev4", msg({ subtype: "message_changed" }))).toBe("subtype message_changed");
    await flush();
    expect(bridge.chatwootMock.upsertContact).not.toHaveBeenCalled();
  });

  it("suppresses echoes: a Slack ts already in `relayed` is not sent again", async () => {
    const bridge = await setup();
    // Simulate a message the bridge itself posted into Slack from Chatwoot.
    await bridge.db.insert(relayed).values({ slackChannel: "C_HELP", slackTs: "1700000000.000200", chatwootMessageId: 999, direction: "chatwoot_to_slack" });
    expect(await acceptSlackMessage(bridge, "Ev9", msg({ ts: "1700000000.000200", thread_ts: "1700000000.000100" }))).toBe("already relayed");
    // And the job itself is idempotent when re-run from the retry queue.
    await relaySlackMessage(bridge, { channel: "C_HELP", ts: "1700000000.000200", user: "U_ALICE", text: "x" });
    expect(bridge.chatwootMock.createContactMessage).not.toHaveBeenCalled();
    expect(bridge.chatwootMock.createAgentMessage).not.toHaveBeenCalled();
  });

  it("relays a thread reply as the contact, naming non-OP repliers", async () => {
    const bridge = await setup();
    await acceptSlackMessage(bridge, "Ev1", msg());
    await flush();
    await acceptSlackMessage(bridge, "Ev2", msg({ ts: "1700000000.000300", thread_ts: "1700000000.000100", text: "more info" }));
    await acceptSlackMessage(bridge, "Ev3", msg({ ts: "1700000000.000400", thread_ts: "1700000000.000100", user: "U_CAROL", text: "same issue here" }));
    await flush();
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenNthCalledWith(2, "src-U_ALICE", 42, "more info", [], "1700000000.000300");
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenNthCalledWith(3, "src-U_ALICE", 42, "**[Not OP] Name U_CAROL:** same issue here", [], "1700000000.000400");
    expect(bridge.chatwootMock.createAgentMessage).not.toHaveBeenCalled();
  });

  it("relays a linked agent's reply as an outgoing message with their own token", async () => {
    const bridge = await setup();
    await upsertAgent(bridge.db, {
      slackUserId: "U_AGENT",
      chatwootAgentId: 7,
      email: "agent@example.com",
      chatwootApiTokenEnc: encryptToken("agent-token", TEST_KEY),
    });
    await acceptSlackMessage(bridge, "Ev1", msg());
    await flush();
    await acceptSlackMessage(bridge, "Ev2", msg({ ts: "1700000000.000500", thread_ts: "1700000000.000100", user: "U_AGENT", text: "try this" }));
    await flush();
    expect(bridge.chatwootMock.createAgentMessage).toHaveBeenCalledWith(42, "try this", { apiToken: "agent-token", attachments: [] });
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores replies in threads the bridge never mapped", async () => {
    const bridge = await setup();
    await acceptSlackMessage(bridge, "Ev1", msg({ ts: "1700000000.000600", thread_ts: "1600000000.000000" }));
    await flush();
    expect(bridge.chatwootMock.upsertContact).not.toHaveBeenCalled();
    expect(bridge.chatwootMock.createContactMessage).not.toHaveBeenCalled();
  });

  it("queues a retry when Chatwoot is down, then succeeds on drain", async () => {
    const bridge = await setup();
    bridge.chatwootMock.createConversation.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await acceptSlackMessage(bridge, "Ev1", msg());
    await flush();
    const queued = await bridge.db.select().from(retries);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: JOB_SLACK_MESSAGE, attempts: 1 });
    expect(queued[0]!.lastError).toContain("ECONNREFUSED");
    expect(await bridge.db.select().from(threads)).toHaveLength(0);

    await bridge.retry.drain(new Date(Date.now() + 10 * 60_000));
    expect(await bridge.db.select().from(retries)).toHaveLength(0);
    expect(await bridge.db.select().from(threads)).toHaveLength(1);
    expect(bridge.chatwootMock.createContactMessage).toHaveBeenCalledTimes(1);
  });
});
