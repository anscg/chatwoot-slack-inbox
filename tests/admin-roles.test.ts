import { eq } from "drizzle-orm";
import express from "express";
import { describe, expect, it } from "vitest";
import { registerAdminApi } from "../src/admin/api.js";
import { seedSuperadmins } from "../src/admin/access.js";
import { adminUsers, bridgeMembers, bridges, threads } from "../src/db/schema.js";
import { ADMIN_COOKIE, Signer } from "../src/session.js";
import { addBridge, makeContext, TEST_KEY, type TestContext } from "./helpers.js";

/** A fetch bound to one signed-in person, with the CSRF header the panel always sends. */
function as(base: string, userId: string) {
  const cookie = `${ADMIN_COOKIE}=${new Signer(TEST_KEY).sign({ userId, name: userId }, 60_000)}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/admin/api${path}`, {
      method,
      headers: { cookie, "x-requested-with": "fetch", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b),
    put: (p: string, b?: unknown) => call("PUT", p, b),
    del: (p: string) => call("DELETE", p),
  };
}

async function withApi(fn: (base: string, ctx: TestContext) => Promise<void>, opts: Parameters<typeof makeContext>[0] = {}) {
  const ctx = await makeContext(opts);
  const app = express();
  registerAdminApi(app, ctx, {
    // The bridge form verifies a pasted token before saving it; answer as a healthy install.
    createSlackClient: () =>
      ({
        ...ctx.slackMock,
        auth: { test: async () => ({ ok: true, user_id: "U0BOT00001", bot_id: "B0BOT00001", team_id: "T0TEAM0001", team: "Test" }) },
        conversations: { ...ctx.slackMock.conversations, info: async () => ({ ok: true, channel: { name: "new-program", is_member: true } }) },
      }) as never,
    createChatwootClient: () => ctx.chatwootMock as never,
  });
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, ctx);
  } finally {
    server.close();
  }
}

/** Put someone on the roster, optionally on a bridge. */
async function person(ctx: TestContext, userId: string, role: "superadmin" | "admin" | "operator", bridge?: { id: number; role: "admin" | "operator" }) {
  await ctx.db.insert(adminUsers).values({ slackUserId: userId, name: userId, role }).onConflictDoUpdate({ target: adminUsers.slackUserId, set: { role } });
  if (bridge) await ctx.db.insert(bridgeMembers).values({ bridgeId: bridge.id, slackUserId: userId, role: bridge.role }).onConflictDoNothing();
}

const bridgeId = async (ctx: TestContext, name: string) => (await ctx.db.select().from(bridges)).find((b) => b.name === name)!.id;

describe("bootstrap", () => {
  it("seeds superadmins from env only while none exist", async () => {
    const ctx = await makeContext({ bridge: false });
    expect(await seedSuperadmins(ctx.db, ["U_ONE"])).toBe(1);

    // With a superadmin in place, the env no longer has a say: someone demoted in the panel
    // stays demoted across restarts.
    await ctx.db.insert(adminUsers).values({ slackUserId: "U_TWO", role: "superadmin" });
    await ctx.db.update(adminUsers).set({ role: "operator" }).where(eq(adminUsers.slackUserId, "U_ONE"));
    expect(await seedSuperadmins(ctx.db, ["U_ONE"])).toBe(0);
    const [one] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.slackUserId, "U_ONE"));
    expect(one!.role).toBe("operator");
  });
});

describe("bridge visibility", () => {
  it("shows a superadmin every bridge and an admin only their own", async () => {
    await withApi(async (base, ctx) => {
      await addBridge(ctx, { name: "other", channel: "C_OTHER", accountId: 2 });
      const help = await bridgeId(ctx, "help");
      await person(ctx, "U_SUPER", "superadmin");
      await person(ctx, "U_OWNER", "admin", { id: help, role: "admin" });
      await person(ctx, "U_STRANGER", "admin");

      expect((await as(base, "U_SUPER").get("/bridges")).body).toHaveLength(2);
      const mine = (await as(base, "U_OWNER").get("/bridges")).body as { name: string; yourRole: string }[];
      expect(mine.map((b) => [b.name, b.yourRole])).toEqual([["help", "admin"]]);
      expect((await as(base, "U_STRANGER").get("/bridges")).body).toEqual([]);
    });
  });

  it("hides a bridge you are not on behind a 404, whatever you try to do to it", async () => {
    await withApi(async (base, ctx) => {
      const help = await bridgeId(ctx, "help");
      await person(ctx, "U_STRANGER", "admin");
      const stranger = as(base, "U_STRANGER");
      expect((await stranger.get(`/bridges/${help}/check`)).status).toBe(404);
      expect((await stranger.put(`/bridges/${help}`, { name: "hijacked" })).status).toBe(404);
      expect((await stranger.del(`/bridges/${help}`)).status).toBe(404);
      expect((await stranger.get(`/bridges/${help}/members`)).status).toBe(404);
      expect((await ctx.db.select().from(bridges).where(eq(bridges.id, help)))[0]!.name).toBe("help");
    });
  });
});

describe("what each role may do", () => {
  it("lets only admins and superadmins create a bridge, and makes the creator its admin", async () => {
    await withApi(async (base, ctx) => {
      await person(ctx, "U_OP", "operator");
      expect((await as(base, "U_OP").post("/bridges", { name: "x" })).status).toBe(403);

      await person(ctx, "U_AUTHOR", "admin");
      ctx.chatwootMock.listInboxes.mockResolvedValue([{ id: 11, name: "API", inbox_identifier: "inbox-1", channel_type: "Channel::Api" }]);
      const created = await as(base, "U_AUTHOR").post("/bridges", {
        name: "new-program",
        slug: "new-program",
        slackChannel: "C0NEW00001",
        slackBotToken: "xoxb-new",
        slackSigningSecret: "signing-secret",
        chatwootAccountId: 1,
        chatwootInboxIdentifier: "inbox-1",
        chatwootApiToken: "service-token",
      });
      expect(created.status).toBe(201);
      expect(created.body.yourRole).toBe("admin");
      const members = await ctx.db.select().from(bridgeMembers).where(eq(bridgeMembers.bridgeId, created.body.id));
      expect(members.map((m) => [m.slackUserId, m.role])).toEqual([["U_AUTHOR", "admin"]]);
    }, { bridge: false });
  });

  it("lets an operator configure their bridge but never invite or delete it", async () => {
    await withApi(async (base, ctx) => {
      const help = await bridgeId(ctx, "help");
      await person(ctx, "U_OWNER", "admin", { id: help, role: "admin" });
      await person(ctx, "U_OP", "operator", { id: help, role: "operator" });
      const op = as(base, "U_OP");

      expect((await op.put(`/bridges/${help}`, { welcomeMessage: "Hi from the operator" })).status).toBe(200);
      expect((await ctx.db.select().from(bridges).where(eq(bridges.id, help)))[0]!.welcomeMessage).toBe("Hi from the operator");
      expect((await op.post(`/bridges/${help}/members`, { slackUserId: "U0FRIEND01" })).status).toBe(403);
      expect((await op.del(`/bridges/${help}`)).status).toBe(403);
      // ...and cannot make a bridge of their own to escape the scoping.
      expect((await op.post("/bridges", { name: "mine" })).status).toBe(403);
      expect((await op.get("/bridges/1/members")).body.canInvite).toBe(false);
    });
  });

  it("lets a bridge admin invite an operator, who then has exactly that one bridge", async () => {
    await withApi(async (base, ctx) => {
      const help = await bridgeId(ctx, "help");
      await addBridge(ctx, { name: "other", channel: "C_OTHER", accountId: 2 });
      await person(ctx, "U_OWNER", "admin", { id: help, role: "admin" });

      const invited = await as(base, "U_OWNER").post(`/bridges/${help}/members`, { slackUserId: "U0NEW00001" });
      expect(invited.status).toBe(201);
      // The invite creates their panel account, at the lowest global role.
      const [row] = await ctx.db.select().from(adminUsers).where(eq(adminUsers.slackUserId, "U0NEW00001"));
      expect(row).toMatchObject({ role: "operator", invitedBy: "U_OWNER" });

      const theirs = (await as(base, "U0NEW00001").get("/bridges")).body as { name: string }[];
      expect(theirs.map((b) => b.name)).toEqual(["help"]);
      expect((await as(base, "U0NEW00001").get("/me")).body.can).toEqual({ createBridge: false, managePeople: false, seeOps: false });
    });
  });

  it("refuses to strip a bridge of its last admin", async () => {
    await withApi(async (base, ctx) => {
      const help = await bridgeId(ctx, "help");
      await person(ctx, "U_OWNER", "admin", { id: help, role: "admin" });
      const res = await as(base, "U_OWNER").del(`/bridges/${help}/members/U_OWNER`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only admin/);
    });
  });
});

describe("the roster", () => {
  it("is superadmin-only", async () => {
    await withApi(async (base, ctx) => {
      await person(ctx, "U_AUTHOR", "admin");
      const author = as(base, "U_AUTHOR");
      expect((await author.get("/people")).status).toBe(403);
      expect((await author.post("/people", { slackUserId: "U0X0000001", role: "superadmin" })).status).toBe(403);
      expect((await author.put("/people/U_AUTHOR", { role: "superadmin" })).status).toBe(403);
      expect((await author.del("/people/U_AUTHOR")).status).toBe(403);
    });
  });

  it("will not let the last superadmin be demoted or removed", async () => {
    await withApi(async (base, ctx) => {
      await person(ctx, "U_SUPER", "superadmin");
      const su = as(base, "U_SUPER");
      expect((await su.put("/people/U_SUPER", { role: "admin" })).status).toBe(400);
      expect((await su.del("/people/U_SUPER")).status).toBe(400);
      expect((await su.post("/people", { slackUserId: "U0TWO00001", role: "superadmin" })).status).toBe(201);
      expect((await su.put("/people/U_SUPER", { role: "admin" })).status).toBe(200);
    });
  });

  it("takes bridge grants away with the person", async () => {
    await withApi(async (base, ctx) => {
      const help = await bridgeId(ctx, "help");
      await person(ctx, "U_SUPER", "superadmin");
      await person(ctx, "U_OP", "operator", { id: help, role: "operator" });
      expect((await as(base, "U_SUPER").del("/people/U_OP")).status).toBe(204);
      expect(await ctx.db.select().from(bridgeMembers).where(eq(bridgeMembers.slackUserId, "U_OP"))).toEqual([]);
      // Their cookie is still valid, but it no longer opens anything.
      expect((await as(base, "U_OP").get("/bridges")).status).toBe(403);
    });
  });
});

describe("ops pages", () => {
  it("filters threads and the webhook secret to what the viewer runs", async () => {
    await withApi(async (base, ctx) => {
      await addBridge(ctx, { name: "other", channel: "C_OTHER", accountId: 2 });
      const help = await bridgeId(ctx, "help");
      await ctx.db.insert(threads).values([
        { slackChannel: "C_HELP", slackThreadTs: "1.1", chatwootAccountId: 1, chatwootConversationId: 1, chatwootContactSourceId: "s1", slackAuthorId: "U_ASKER" },
        { slackChannel: "C_OTHER", slackThreadTs: "2.1", chatwootAccountId: 2, chatwootConversationId: 2, chatwootContactSourceId: "s2", slackAuthorId: "U_OTHER" },
      ]);
      await person(ctx, "U_SUPER", "superadmin");
      await person(ctx, "U_OWNER", "admin", { id: help, role: "admin" });

      expect((await as(base, "U_SUPER").get("/threads")).body).toHaveLength(2);
      const seen = (await as(base, "U_OWNER").get("/threads")).body as { slackChannel: string }[];
      expect(seen.map((t) => t.slackChannel)).toEqual(["C_HELP"]);

      // The webhook URL carries the install-wide Chatwoot secret.
      expect((await as(base, "U_SUPER").get("/status")).body.webhookUrl).toContain("webhook-secret");
      const scoped = (await as(base, "U_OWNER").get("/status")).body;
      expect(scoped.webhookUrl).toBeUndefined();
      expect(scoped.counts.threads).toBe(1);
    });
  });

  it("gives someone with no bridges an empty list rather than everything", async () => {
    await withApi(async (base, ctx) => {
      await ctx.db.insert(threads).values({
        slackChannel: "C_HELP",
        slackThreadTs: "1.1",
        chatwootAccountId: 1,
        chatwootConversationId: 1,
        chatwootContactSourceId: "s1",
        slackAuthorId: "U_ASKER",
      });
      await person(ctx, "U_NEW", "admin");
      const them = as(base, "U_NEW");
      expect((await them.get("/threads")).body).toEqual([]);
      expect((await them.get("/agents")).body).toEqual([]);
      expect((await them.get("/status")).body.counts).toMatchObject({ threads: 0, relayed: 0 });
    });
  });
});

describe("the helper roster over the API", () => {
  /** The bridge from `withApi`, pointed at a helper channel with `members` in it. */
  async function pointAtHelperChannel(ctx: TestContext, members: string[]) {
    const id = await bridgeId(ctx, "help");
    await ctx.db.update(bridges).set({ helperChannel: "C_TEAM" }).where(eq(bridges.id, id));
    await ctx.bridges.reload();
    ctx.bridges.get(id)!.chatwoot = ctx.chatwootMock as never;
    ctx.slackMock.conversations.members.mockImplementation(async () => ({ ok: true, members }));
    return id;
  }

  it("lets an operator look but not provision", async () => {
    await withApi(async (base, ctx) => {
      const id = await pointAtHelperChannel(ctx, ["U0NEW00001"]);
      await person(ctx, "U_OP", "operator", { id, role: "operator" });
      const them = as(base, "U_OP");

      const review = await them.post(`/bridges/${id}/helpers/review`);
      expect(review.status).toBe(200);
      expect(review.body.canProvision).toBe(false);
      expect((await them.post(`/bridges/${id}/helpers/provision`, { slackUserIds: ["U0NEW00001"], expected: 1 })).status).toBe(403);
      // Nor may they quietly switch auto-provisioning on for themselves.
      expect((await them.put(`/bridges/${id}`, { helperAutoProvision: "all" })).status).toBe(403);
      expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    });
  });

  it("refuses a list that is not the length the reviewer approved", async () => {
    await withApi(async (base, ctx) => {
      const id = await pointAtHelperChannel(ctx, ["U0ONE00001", "U0TWO00001"]);
      await person(ctx, "U_OWNER", "admin", { id, role: "admin" });
      const res = await as(base, "U_OWNER").post(`/bridges/${id}/helpers/provision`, { slackUserIds: ["U0ONE00001", "U0TWO00001"], expected: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("you approved 1");
      expect(ctx.chatwootMock.createAgent).not.toHaveBeenCalled();
    });
  });

  it("provisions the named people for a bridge admin and logs who did it", async () => {
    await withApi(async (base, ctx) => {
      const id = await pointAtHelperChannel(ctx, ["U0ONE00001", "U0TWO00001"]);
      await person(ctx, "U_OWNER", "admin", { id, role: "admin" });
      const res = await as(base, "U_OWNER").post(`/bridges/${id}/helpers/provision`, { slackUserIds: ["U0ONE00001"], expected: 1 });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(ctx.chatwootMock.createAgent).toHaveBeenCalledTimes(1);

      const roster = (await as(base, "U_OWNER").get(`/bridges/${id}/helpers`)).body;
      expect(roster.members.map((m: { slackUserId: string }) => m.slackUserId)).toEqual(["U0ONE00001"]);
      expect(roster.events.some((e: { action: string; actor: string }) => e.action === "provisioned" && e.actor === "U_OWNER")).toBe(true);
    });
  });

  it("says so plainly when the bridge has no helper channel", async () => {
    await withApi(async (base, ctx) => {
      const id = await bridgeId(ctx, "help");
      await person(ctx, "U_OWNER", "admin", { id, role: "admin" });
      const res = await as(base, "U_OWNER").post(`/bridges/${id}/helpers/review`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no helper channel");
    });
  });
});
