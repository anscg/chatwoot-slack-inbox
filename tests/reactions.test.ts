import { describe, expect, it } from "vitest";
import { encryptToken } from "../src/crypto.js";
import { threads } from "../src/db/schema.js";
import { acceptResolveButton, acceptSlackReaction, applySlackReaction, JOB_SLACK_REACTION, type IncomingSlackReaction } from "../src/slack/events.js";
import { upsertAgent } from "../src/store.js";
import { flush, makeContext, TEST_KEY, type BridgeOverrides } from "./helpers.js";

const PARENT = "1700000000.000100";

function reaction(user: string, name: string, ts = PARENT, channel = "C_HELP"): IncomingSlackReaction {
  return { type: "reaction_added", user, reaction: name, item: { type: "message", channel, ts } };
}

async function setup(bridge?: BridgeOverrides) {
  const ctx = await makeContext({ bridge });
  ctx.retry.register(JOB_SLACK_REACTION, (p) => applySlackReaction(ctx, p as never));
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "src-U_ALICE",
    slackAuthorId: "U_ALICE",
  });
  await upsertAgent(ctx.db, { slackUserId: "U_AGENT", chatwootAgentId: 7, chatwootApiTokenEnc: encryptToken("agent-token", TEST_KEY) });
  await upsertAgent(ctx.db, { slackUserId: "U_AGENT_NOTOKEN", chatwootAgentId: 8 });
  return ctx;
}

describe("✅ resolve gate", () => {
  it("a linked agent resolves via the application API with their own token", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT", "white_check_mark"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", "agent-token");
    expect(ctx.chatwootMock.toggleStatusAsContact).not.toHaveBeenCalled();
  });

  it("an agent without a Chatwoot token falls back to the service token", async () => {
    const ctx = await setup();
    await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT_NOTOKEN", "white_check_mark"));
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", undefined);
  });

  it("the original author resolves via the public API, but not when already resolved", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_ALICE", "white_check_mark"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsContact).toHaveBeenCalledWith("src-U_ALICE", 42);
    expect(ctx.chatwootMock.toggleStatusAsAgent).not.toHaveBeenCalled();

    ctx.chatwootMock.listContactConversations.mockResolvedValueOnce([{ id: 42, status: "resolved" }]);
    await acceptSlackReaction(ctx, "Ev2", reaction("U_ALICE", "white_check_mark"));
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsContact).toHaveBeenCalledTimes(1);
  });

  it("anyone else is ignored silently", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_RANDO", "white_check_mark"))).toBe("resolve: not agent or author");
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsContact).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.toggleStatusAsAgent).not.toHaveBeenCalled();
  });

  it("only reactions on the thread parent count, and events are deduped", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT", "white_check_mark", "1700000000.000999"))).toBe("not a thread parent");
    expect(await acceptSlackReaction(ctx, "Ev2", reaction("U_AGENT", "white_check_mark"))).toBeNull();
    expect(await acceptSlackReaction(ctx, "Ev2", reaction("U_AGENT", "white_check_mark"))).toBe("duplicate event");
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledTimes(1);
  });
});

describe("👀 assign", () => {
  it("assigns to the reacting agent", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT", "eyes"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.assignConversation).toHaveBeenCalledWith(42, 7, "agent-token");
  });

  it("ignores non-agents, even the original author", async () => {
    const ctx = await setup();
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_ALICE", "eyes"))).toBe("assign: not a linked agent");
    await flush();
    expect(ctx.chatwootMock.assignConversation).not.toHaveBeenCalled();
  });
});

describe("per-bridge reaction configuration", () => {
  it("uses the bridge's configured emoji", async () => {
    const ctx = await setup({ reactionResolve: "heavy_check_mark", reactionAssign: "raised_hand" });
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT", "white_check_mark"))).toBe("unconfigured reaction");
    expect(await acceptSlackReaction(ctx, "Ev2", reaction("U_AGENT", "heavy_check_mark"))).toBeNull();
    expect(await acceptSlackReaction(ctx, "Ev3", reaction("U_AGENT", "raised_hand"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledTimes(1);
    expect(ctx.chatwootMock.assignConversation).toHaveBeenCalledTimes(1);
  });

  it("a disabled reaction does nothing", async () => {
    const ctx = await setup({ reactionAssign: null });
    expect(await acceptSlackReaction(ctx, "Ev1", reaction("U_AGENT", "eyes"))).toBe("unconfigured reaction");
    expect(await acceptSlackReaction(ctx, "Ev2", reaction("U_AGENT", "white_check_mark"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.assignConversation).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledTimes(1);
  });
});

describe("Resolve button", () => {
  const click = (user: string, over: Partial<Parameters<typeof acceptResolveButton>[1]> = {}) => ({
    channel: "C_HELP",
    threadTs: PARENT,
    user,
    triggerId: `trig-${user}-${Math.random()}`,
    ...over,
  });

  it("resolves for a linked agent (a helper)", async () => {
    const ctx = await setup();
    expect(await acceptResolveButton(ctx, click("U_AGENT"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledWith(42, "resolved", "agent-token");
  });

  it("resolves for the person who asked, via the public API", async () => {
    const ctx = await setup();
    expect(await acceptResolveButton(ctx, click("U_ALICE"))).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsContact).toHaveBeenCalledWith("src-U_ALICE", 42);
  });

  it("tells anyone else why they cannot, and does nothing", async () => {
    const ctx = await setup();
    expect(await acceptResolveButton(ctx, click("U_RANDO"))).toBe("Only the person who asked or a helper can resolve this thread.");
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).not.toHaveBeenCalled();
    expect(ctx.chatwootMock.toggleStatusAsContact).not.toHaveBeenCalled();
  });

  it("ignores a duplicate delivery of the same click and an unknown thread", async () => {
    const ctx = await setup();
    const one = click("U_AGENT");
    expect(await acceptResolveButton(ctx, one)).toBeNull();
    expect(await acceptResolveButton(ctx, one)).toBeNull();
    await flush();
    expect(ctx.chatwootMock.toggleStatusAsAgent).toHaveBeenCalledTimes(1);
    expect(await acceptResolveButton(ctx, click("U_AGENT", { threadTs: "1700000000.009999" }))).toBe("I can't find this thread in Chatwoot.");
  });
});
