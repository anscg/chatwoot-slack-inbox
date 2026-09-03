import { describe, expect, it } from "vitest";
import { applyChatwootStatus, classifyWebhook } from "../src/chatwoot/webhook.js";
import { threads } from "../src/db/schema.js";
import { makeContext } from "./helpers.js";

const PARENT = "1700000000.000100";

async function setup() {
  const ctx = await makeContext();
  await ctx.db.insert(threads).values({
    slackChannel: "C_HELP",
    slackThreadTs: PARENT,
    chatwootAccountId: 1,
    chatwootConversationId: 42,
    chatwootContactSourceId: "s",
    slackAuthorId: "U_ALICE",
    welcomeMessageTs: "1700000000.000101",
  });
  let n = 0;
  ctx.slackMock.chat.postMessage.mockImplementation(async () => ({ ok: true, ts: `1700000000.00090${n++}` }));
  return ctx;
}

describe("status messages", () => {
  it("classifies conversation_status_changed, resolving the account from the inbox id when absent", () => {
    const r = classifyWebhook({ event: "conversation_status_changed", id: 42, status: "resolved", inbox_id: 11 } as never);
    expect(r).toEqual({ statusJob: { conversationId: 42, status: "resolved", inboxId: 11 } });
  });

  it("posts the resolved notice, then swaps it for the reopened notice, then swaps back", async () => {
    const ctx = await setup();
    await applyChatwootStatus(ctx, { conversationId: 42, status: "resolved", inboxId: 11 });
    expect(ctx.slackMock.chat.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: PARENT, text: ":neocat: Help request marked as resolved." }));
    // The bot stamps the question itself.
    expect(ctx.slackMock.reactions.add).toHaveBeenCalledWith({ channel: "C_HELP", timestamp: PARENT, name: "white_check_mark" });
    // The notice itself carries the button for the new state.
    const notice = ctx.slackMock.chat.postMessage.mock.calls[0]![0] as { blocks: { elements?: { text?: { text?: string }; value?: string }[] }[] };
    expect(notice.blocks[1]?.elements?.[0]).toMatchObject({ text: { text: "Reopen" }, value: `reopen:${PARENT}` });
    expect(ctx.slackMock.chat.delete).not.toHaveBeenCalled();
    let [t] = await ctx.db.select().from(threads);
    expect(t).toMatchObject({ lastStatus: "resolved", statusMessageTs: "1700000000.000900" });

    // Duplicate delivery: nothing happens.
    await applyChatwootStatus(ctx, { conversationId: 42, status: "resolved", accountId: 1 });
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(1);

    // The welcome message's button now offers Reopen.
    const edit = ctx.slackMock.chat.update.mock.calls[0]![0] as { ts: string; blocks: { elements?: { text?: { text?: string }; value?: string }[] }[] };
    expect(edit.ts).toBe("1700000000.000101");
    expect(edit.blocks[1]?.elements?.[0]).toMatchObject({ text: { text: "Reopen" }, value: `reopen:${PARENT}` });

    // Contact replies -> Chatwoot reopens.
    await applyChatwootStatus(ctx, { conversationId: 42, status: "open", accountId: 1 });
    expect(ctx.slackMock.chat.delete).toHaveBeenCalledWith({ channel: "C_HELP", ts: "1700000000.000900" });
    expect(ctx.slackMock.chat.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Thread reopened." }));
    expect(ctx.slackMock.reactions.remove).toHaveBeenCalledWith({ channel: "C_HELP", timestamp: PARENT, name: "white_check_mark" });
    const reopened = ctx.slackMock.chat.postMessage.mock.calls[1]![0] as { blocks: { elements?: { text?: { text?: string }; value?: string }[] }[] };
    expect(reopened.blocks[1]?.elements?.[0]).toMatchObject({ text: { text: "Resolve" }, value: `resolve:${PARENT}` });
    [t] = await ctx.db.select().from(threads);
    expect(t).toMatchObject({ lastStatus: "open", statusMessageTs: "1700000000.000901" });
    const back = ctx.slackMock.chat.update.mock.calls[1]![0] as { blocks: { elements?: { text?: { text?: string } }[] }[] };
    expect(back.blocks[1]?.elements?.[0]).toMatchObject({ text: { text: "Resolve" } });

    // Resolved again: the "reopened" notice goes away, resolved notice returns.
    await applyChatwootStatus(ctx, { conversationId: 42, status: "resolved", accountId: 1 });
    expect(ctx.slackMock.chat.delete).toHaveBeenLastCalledWith({ channel: "C_HELP", ts: "1700000000.000901" });
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalledTimes(3);
  });

  it("does not announce pending->open as a reopen, and honours disabled messages", async () => {
    const ctx = await setup();
    await applyChatwootStatus(ctx, { conversationId: 42, status: "pending", accountId: 1 });
    await applyChatwootStatus(ctx, { conversationId: 42, status: "open", accountId: 1 });
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
    await ctx.db.update(await import("../src/db/schema.js").then((m) => m.bridges)).set({ resolveMessage: null });
    await ctx.bridges.reload();
    await applyChatwootStatus(ctx, { conversationId: 42, status: "resolved", accountId: 1 });
    expect(ctx.slackMock.chat.postMessage).not.toHaveBeenCalled();
  });
});
