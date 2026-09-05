import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bridge } from "../src/bridges.js";
import {
  askHelpersToLink,
  findHelperMember,
  listHelperEvents,
  provisionHelpers,
  recordHelperJoin,
  recordHelperLeave,
  provisionLinkedHelper,
  reviewHelpers,
  skipHelper,
  unlinkHelper,
} from "../src/helpers.js";
import { agents, bridges, helperEvents } from "../src/db/schema.js";
import { clearProfileCache } from "../src/slack/users.js";
import { makeContext, type TestContext } from "./helpers.js";

/** A bridge whose helper channel is #C_TEAM, with `members` in it. */
async function withHelpers(
  opts: { members?: string[]; auto?: "off" | "existing" | "all"; offboarding?: "keep" | "unlink"; maxBatch?: number; linkPrompt?: string | null } = {},
) {
  const ctx = await makeContext({
    bridge: {
      helperChannel: "C_TEAM",
      helperAutoProvision: opts.auto ?? "off",
      helperOffboarding: opts.offboarding ?? "unlink",
      helperMaxBatch: opts.maxBatch,
      ...(opts.linkPrompt !== undefined ? { helperLinkPrompt: opts.linkPrompt } : {}),
    },
  });
  ctx.slackMock.conversations.members.mockImplementation(async () => ({ ok: true, members: opts.members ?? [] }));
  return { ctx, bridge: ctx.bridges.forChannel("C_HELP")! };
}

const bridgeId = async (ctx: TestContext) => (await ctx.db.select().from(bridges))[0]!.id;

beforeEach(() => clearProfileCache());

describe("reviewing a helper channel", () => {
  it("sorts people by what provisioning them would actually do", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_ON", "U_KNOWN", "U_NEW", "U_BOT2"] });
    // U_ON is already an agent on the account, by the email their Slack profile carries.
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 11, name: "On", email: "u_on@example.com" }]);
    // U_KNOWN linked their account and matched a Chatwoot user, but not one on this account.
    await ctx.db.insert(agents).values({ slackUserId: "U_KNOWN", chatwootAgentId: 22, email: "known@hackclub.com" });
    ctx.slackMock.users.info.mockImplementation(async ({ user }: { user: string }) => ({
      ok: true,
      user:
        user === "U_BOT2"
          ? { id: user, is_bot: true, real_name: "Bridge Bot", profile: {} }
          : { id: user, real_name: user, profile: { display_name: user, email: `${user.toLowerCase()}@example.com` } },
    }));

    const review = await reviewHelpers(ctx, bridge);
    const bucket = (id: string) => review.candidates.find((c) => c.slackUserId === id)!.bucket;
    expect(review.memberCount).toBe(4);
    expect(bucket("U_ON")).toBe("member");
    expect(bucket("U_KNOWN")).toBe("existing");
    expect(bucket("U_NEW")).toBe("invite");
    expect(bucket("U_BOT2")).toBe("blocked");
    // The linked email wins over the Slack one: inviting the Slack address would make a second account.
    const known = review.candidates.find((c) => c.slackUserId === "U_KNOWN")!;
    expect(known.email).toBe("known@hackclub.com");
    expect(known.emailSource).toBe("chatwoot");
  });

  it("only calls an address confirmed when a Chatwoot user backs it", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_COPIED", "U_HCA", "U_BARE"] });
    // /link stores the Slack address whether or not it matched, so this one is worth nothing extra.
    await ctx.db.insert(agents).values([
      { slackUserId: "U_COPIED", email: "u_copied@example.com" },
      { slackUserId: "U_HCA", email: "someone@hackclub.com" },
    ]);
    const by = Object.fromEntries((await reviewHelpers(ctx, bridge)).candidates.map((c) => [c.slackUserId, c]));
    expect(by.U_COPIED!.emailSource).toBe("slack");
    expect(by.U_HCA!.emailSource).toBe("hackclub");
    expect(by.U_BARE!.emailSource).toBe("slack");
    // None of them is confirmed, so all three would be brand new Chatwoot accounts.
    expect([by.U_COPIED!.bucket, by.U_HCA!.bucket, by.U_BARE!.bucket]).toEqual(["invite", "invite", "invite"]);
  });

  it("blocks anyone with no email at all", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_NOMAIL"] });
    ctx.slackMock.users.info.mockResolvedValue({ ok: true, user: { id: "U_NOMAIL", real_name: "No Mail", profile: {} } });
    const review = await reviewHelpers(ctx, bridge);
    expect(review.candidates[0]!.bucket).toBe("blocked");
    expect(review.candidates[0]!.reason).toContain("no email");
  });

  it("reviews nobody into Chatwoot: it only reads", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_NEW"] });
    await reviewHelpers(ctx, bridge);
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect(await findHelperMember(ctx.db, bridge.row.id, "U_NEW")).toBeUndefined();
  });

  it("notices somebody who left while nobody was listening, without touching Chatwoot", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_STAY"] });
    await provisionHelpers(ctx, bridge, ["U_GONE"], { actor: "U_ADMIN" });
    const review = await reviewHelpers(ctx, bridge);
    expect(review.departed.map((c) => c.slackUserId)).toEqual(["U_GONE"]);
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_GONE"))!.inChannel).toBe(false);
    // Still an agent: a review never unlinks anyone, that stays a deliberate click.
    expect(ctx.chatwootMock.removeAgentFromAccount).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_GONE"))!.state).toBe("provisioned");
  });

  it("reports a service token that is not an account administrator", async () => {
    const { ctx, bridge } = await withHelpers({ members: [] });
    ctx.chatwootMock.whoAmI.mockResolvedValue({ id: 7, name: "Svc", email: "svc@example.com", accounts: [{ id: 1, name: "Acct", role: "agent" }] });
    expect((await reviewHelpers(ctx, bridge)).serviceToken).toMatchObject({ role: "agent", canProvision: false });
  });
});

describe("provisioning", () => {
  it("creates a Chatwoot agent only for the people named", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_ONE", "U_TWO", "U_THREE"] });
    const results = await provisionHelpers(ctx, bridge, ["U_TWO"], { actor: "U_ADMIN" });
    expect(results).toHaveLength(1);
    expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(1);
    expect(ctx.chatwootMock.createAgent.mock.calls[0]![0]).toMatchObject({ email: "u_two@example.com", role: "agent" });
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_TWO"))!.state).toBe("provisioned");
    expect(await findHelperMember(ctx.db, bridge.row.id, "U_ONE")).toBeUndefined();
  });

  it("refuses a batch bigger than the bridge allows", async () => {
    const { ctx, bridge } = await withHelpers({ members: [], maxBatch: 2 });
    await expect(provisionHelpers(ctx, bridge, ["U_A", "U_B", "U_C"], { actor: "U_ADMIN" })).rejects.toThrow(/limit is 2/);
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });

  it("links somebody who is already an agent instead of creating a second one", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_ON"] });
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 11, name: "On", email: "u_on@example.com" }]);
    const [result] = await provisionHelpers(ctx, bridge, ["U_ON"], { actor: "U_ADMIN" });
    expect(result).toMatchObject({ ok: true, bucket: "member", chatwootUserId: 11 });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });

  it("records a Chatwoot refusal against the person rather than losing it", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_BAD"] });
    ctx.chatwootMock.createAgent.mockRejectedValue(new Error("email is invalid"));
    const [result] = await provisionHelpers(ctx, bridge, ["U_BAD"], { actor: "U_ADMIN" });
    expect(result!.ok).toBe(false);
    const row = (await findHelperMember(ctx.db, bridge.row.id, "U_BAD"))!;
    expect(row.state).toBe("failed");
    expect(row.lastError).toContain("email is invalid");
  });

  it("leaves a would-be invitation alone when only existing users are allowed", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_NEW"] });
    const [result] = await provisionHelpers(ctx, bridge, ["U_NEW"], { actor: null, allow: "existing" });
    expect(result).toMatchObject({ ok: false, bucket: "invite" });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_NEW"))!.state).toBe("pending");
  });
});

describe("joining and leaving", () => {
  it("records a join but provisions nobody while auto-provisioning is off", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_JOIN"], auto: "off" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_JOIN" });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    const row = (await findHelperMember(ctx.db, bridge.row.id, "U_JOIN"))!;
    expect(row.state).toBe("pending");
    expect(row.inChannel).toBe(true);
    expect((await listHelperEvents(ctx.db, bridge.row.id)).map((e) => e.action)).toContain("joined");
  });

  it("provisions a known user on join, and leaves an unknown one pending", async () => {
    const { ctx, bridge } = await withHelpers({ members: [], auto: "existing" });
    await ctx.db.insert(agents).values({ slackUserId: "U_KNOWN", chatwootAgentId: 22, email: "known@hackclub.com" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_KNOWN" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_STRANGER" });
    expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(1);
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_KNOWN"))!.state).toBe("provisioned");
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_STRANGER"))!.state).toBe("pending");
  });

  it("never provisions somebody a human skipped", async () => {
    const { ctx, bridge } = await withHelpers({ members: [], auto: "all" });
    await skipHelper(ctx, bridge.row.id, "U_NOPE", "U_ADMIN");
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_NOPE" });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_NOPE"))!.state).toBe("skipped");
  });

  it("stops provisioning when a burst of people is added at once", async () => {
    const { ctx, bridge } = await withHelpers({ members: [], auto: "all", maxBatch: 3 });
    for (const id of ["U_A", "U_B", "U_C", "U_D", "U_E"]) await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: id });
    // Three go through; the fourth trips the guard and the fifth finds it already tripped.
    expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(3);
    const row = (await ctx.db.select().from(bridges).where(eq(bridges.id, bridge.row.id)))[0]!;
    expect(row.helperPausedAt).not.toBeNull();
    expect(row.helperPausedReason).toContain("over this bridge's limit");
    // Nobody is dropped: the ones who arrived during the burst are waiting for review.
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_E"))!.state).toBe("pending");
    expect((await ctx.db.select().from(helperEvents).where(eq(helperEvents.action, "paused"))).length).toBe(1);
  });

  it("unlinks a leaver from the account and keeps their Chatwoot user", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_LEAVE"], offboarding: "unlink" });
    await provisionHelpers(ctx, bridge, ["U_LEAVE"], { actor: "U_ADMIN" });
    const chatwootUserId = (await findHelperMember(ctx.db, bridge.row.id, "U_LEAVE"))!.chatwootUserId;
    await recordHelperLeave(ctx, { bridgeId: bridge.row.id, slackUserId: "U_LEAVE" });

    expect(ctx.chatwootMock.removeAgentFromAccount).toHaveBeenCalledWith(chatwootUserId, expect.anything());
    const row = (await findHelperMember(ctx.db, bridge.row.id, "U_LEAVE"))!;
    // The row and the Chatwoot user id survive, so coming back finds the same person again.
    expect(row.state).toBe("unlinked");
    expect(row.chatwootUserId).toBe(chatwootUserId);
    expect(row.inChannel).toBe(false);
  });

  it("only records the departure when offboarding is set to keep", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_LEAVE"], offboarding: "keep" });
    await provisionHelpers(ctx, bridge, ["U_LEAVE"], { actor: "U_ADMIN" });
    await recordHelperLeave(ctx, { bridgeId: bridge.row.id, slackUserId: "U_LEAVE" });
    expect(ctx.chatwootMock.removeAgentFromAccount).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_LEAVE"))!.state).toBe("provisioned");
  });

  it("puts somebody who comes back up for review again", async () => {
    const { ctx, bridge } = await withHelpers({ members: [], offboarding: "unlink", auto: "off" });
    await provisionHelpers(ctx, bridge, ["U_BACK"], { actor: "U_ADMIN" });
    await recordHelperLeave(ctx, { bridgeId: bridge.row.id, slackUserId: "U_BACK" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_BACK" });
    const row = (await findHelperMember(ctx.db, bridge.row.id, "U_BACK"))!;
    expect(row.state).toBe("pending");
    expect(row.inChannel).toBe(true);
    expect(row.chatwootUserId).not.toBeNull();
  });

  it("drops a queued join for a bridge that has gone away", async () => {
    const { ctx } = await withHelpers({ members: [] });
    await expect(recordHelperJoin(ctx, { bridgeId: 9999, slackUserId: "U_X" })).resolves.toBeUndefined();
    expect(await findHelperMember(ctx.db, await bridgeId(ctx), "U_X")).toBeUndefined();
  });
});

describe("unlinking", () => {
  it("removes the account membership and never deletes the Chatwoot user", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_ONE"] });
    await provisionHelpers(ctx, bridge, ["U_ONE"], { actor: "U_ADMIN" });
    const detail = await unlinkHelper(ctx, bridge, "U_ONE", "U_ADMIN");
    expect(detail).toContain("Chatwoot user was kept");
    expect(ctx.chatwootMock.removeAgentFromAccount).toHaveBeenCalledTimes(1);
    // The client deliberately exposes no way to delete a Chatwoot user, only to leave an account.
    const { ChatwootClient } = await import("../src/chatwoot/client.js");
    const methods = Object.getOwnPropertyNames(ChatwootClient.prototype);
    expect(methods.filter((m) => /^delete/i.test(m) && /user|agent|account/i.test(m))).toEqual([]);
    const events = await listHelperEvents(ctx.db, bridge.row.id);
    expect(events.some((e) => e.action === "unlinked" && e.actor === "U_ADMIN")).toBe(true);
  });

  it("treats an already-gone membership as done", async () => {
    const { ctx, bridge } = await withHelpers({ members: ["U_ONE"] });
    await provisionHelpers(ctx, bridge, ["U_ONE"], { actor: "U_ADMIN" });
    const { ChatwootHttpError } = await import("../src/chatwoot/client.js");
    ctx.chatwootMock.removeAgentFromAccount.mockRejectedValue(new ChatwootHttpError(404, "/agents/1", "not found"));
    await expect(unlinkHelper(ctx, bridge, "U_ONE", "U_ADMIN")).resolves.toBeTruthy();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_ONE"))!.state).toBe("unlinked");
  });
});

describe("asking people to link instead of guessing an address", () => {
  /** The direct messages the bridge bot sent, as [recipient, text] pairs. */
  const dms = (ctx: TestContext) =>
    ctx.slackMock.chat.postMessage.mock.calls.map((c) => [(c[0] as { channel: string }).channel, (c[0] as { text: string }).text] as const);

  it("asks an unconfirmed joiner rather than inventing a Chatwoot account for them", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });

    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect(dms(ctx)).toEqual([["U_UNKNOWN", "Link your account for <#C_TEAM>: https://bridge.test/link"]]);
    const row = (await findHelperMember(ctx.db, bridge.row.id, "U_UNKNOWN"))!;
    expect(row.state).toBe("pending");
    expect(row.linkAskedAt).not.toBeNull();
    expect((await listHelperEvents(ctx.db, bridge.row.id)).some((e) => e.action === "asked")).toBe(true);
  });

  it("provisions a confirmed joiner and does not pester them", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await ctx.db.insert(agents).values({ slackUserId: "U_KNOWN", chatwootAgentId: 22, email: "known@hackclub.com" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_KNOWN" });
    expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(1);
    expect(dms(ctx)).toEqual([]);
  });

  it("says nothing at all while auto-provisioning is off", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "off" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });
    expect(dms(ctx)).toEqual([]);
  });

  it("does not ask when the bridge has no message configured", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing", linkPrompt: null });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });
    expect(dms(ctx)).toEqual([]);
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_UNKNOWN"))!.state).toBe("pending");
  });

  it("asks nobody twice in a week, however often they rejoin", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });
    await recordHelperLeave(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_UNKNOWN" });
    expect(dms(ctx)).toHaveLength(1);

    // Eight days later they are worth another nudge.
    const later = new Date(Date.now() + 8 * 24 * 60 * 60_000);
    const [result] = await askHelpersToLink(ctx, bridge, ["U_UNKNOWN"], { actor: "U_ADMIN", now: later });
    expect(result).toMatchObject({ ok: true });
    expect(dms(ctx)).toHaveLength(2);
  });

  it("never direct-messages a bot, or somebody a human skipped", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    ctx.slackMock.users.info.mockImplementation(async ({ user }: { user: string }) => ({
      ok: true,
      user: user === "U_BOT2" ? { id: user, is_bot: true, real_name: "Bot", profile: {} } : { id: user, real_name: user, profile: { display_name: user } },
    }));
    await skipHelper(ctx, bridge.row.id, "U_NOPE", "U_ADMIN");
    const results = await askHelpersToLink(ctx, bridge, ["U_BOT2", "U_NOPE"], { actor: "U_ADMIN" });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(dms(ctx)).toEqual([]);
  });

  it("asking creates nothing in Chatwoot", async () => {
    const { ctx, bridge } = await withHelpers({});
    await askHelpersToLink(ctx, bridge, ["U_UNKNOWN"], { actor: "U_ADMIN" });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_UNKNOWN"))!.state).toBe("pending");
  });

  it("refuses to message more people at once than the bridge allows", async () => {
    const { ctx, bridge } = await withHelpers({ maxBatch: 2 });
    await expect(askHelpersToLink(ctx, bridge, ["U_A", "U_B", "U_C"], { actor: "U_ADMIN" })).rejects.toThrow(/limit is 2/);
    expect(dms(ctx)).toEqual([]);
  });
});

describe("finishing the job when somebody links", () => {
  it("provisions a waiting helper the moment linking makes them recognisable", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_LATE" });
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();

    // What /link does once Hack Club Auth finds their Chatwoot user.
    await ctx.db.insert(agents).values({ slackUserId: "U_LATE", chatwootAgentId: 33, email: "late@hackclub.com" });
    await provisionLinkedHelper(ctx, "U_LATE");

    expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(1);
    expect(ctx.chatwootMock.createAgent.mock.calls[0]![0]).toMatchObject({ email: "late@hackclub.com" });
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_LATE"))!.state).toBe("provisioned");
  });

  it("still invites nobody: linking without a Chatwoot match leaves them waiting", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_LATE" });
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_LATE"))!.state).toBe("pending");
    // /link stored their Slack address but matched no Chatwoot user, so we still know nothing.
    await ctx.db.insert(agents).values({ slackUserId: "U_LATE", email: "u_late@example.com" });
    await provisionLinkedHelper(ctx, "U_LATE");
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_LATE"))!.state).toBe("pending");
  });

  it("does not invite even on the most permissive policy — linking is for confirming, not guessing", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "all" });
    // Sitting pending because the burst guard caught the join, not because anyone chose it.
    await ctx.db.insert(agents).values({ slackUserId: "U_LATE", email: "u_late@example.com" });
    await askHelpersToLink(ctx, bridge, ["U_LATE"], { actor: "U_ADMIN" });
    await provisionLinkedHelper(ctx, "U_LATE");
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });

  it("leaves alone somebody who has left the channel, or whom a human skipped", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "existing" });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_GONE" });
    await recordHelperLeave(ctx, { bridgeId: bridge.row.id, slackUserId: "U_GONE" });
    await skipHelper(ctx, bridge.row.id, "U_NOPE", "U_ADMIN");
    await ctx.db.insert(agents).values([
      { slackUserId: "U_GONE", chatwootAgentId: 44, email: "gone@hackclub.com" },
      { slackUserId: "U_NOPE", chatwootAgentId: 55, email: "nope@hackclub.com" },
    ]);
    await provisionLinkedHelper(ctx, "U_GONE");
    await provisionLinkedHelper(ctx, "U_NOPE");
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });

  it("finishes off somebody it asked to link, even where nothing is provisioned automatically", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "off", members: ["U_ASKED"] });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_ASKED" });
    await askHelpersToLink(ctx, bridge, ["U_ASKED"], { actor: "U_ADMIN" });
    expect(ctx.slackMock.chat.postMessage).toHaveBeenCalled();

    await ctx.db.insert(agents).values({ slackUserId: "U_ASKED", chatwootAgentId: 66, email: "asked@hackclub.com", emailSource: "hackclub" });
    await provisionLinkedHelper(ctx, "U_ASKED");

    expect(ctx.chatwootMock.createAgent.mock.calls[0]![0]).toMatchObject({ email: "asked@hackclub.com" });
    expect((await findHelperMember(ctx.db, bridge.row.id, "U_ASKED"))!.state).toBe("provisioned");
  });

  it("leaves somebody nobody asked alone when the bridge provisions nobody automatically", async () => {
    const { ctx, bridge } = await withHelpers({ auto: "off", members: ["U_QUIET"] });
    await recordHelperJoin(ctx, { bridgeId: bridge.row.id, slackUserId: "U_QUIET" });
    await ctx.db.insert(agents).values({ slackUserId: "U_QUIET", chatwootAgentId: 77, email: "quiet@hackclub.com", emailSource: "hackclub" });
    await provisionLinkedHelper(ctx, "U_QUIET");
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });

  it("does nothing for somebody who is in no helper channel at all", async () => {
    const { ctx } = await withHelpers({ auto: "all" });
    await provisionLinkedHelper(ctx, "U_STRANGER");
    expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
  });
});
