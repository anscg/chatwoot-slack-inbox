import express from "express";
import { describe, expect, it } from "vitest";
import { listChatwootAgents, requireAdmin } from "../src/admin/api.js";
import { adminUsers } from "../src/db/schema.js";
import { addBridge, createTestDb, makeContext } from "./helpers.js";
import { ADMIN_COOKIE, Signer } from "../src/session.js";
import { TEST_KEY } from "./helpers.js";

async function withServer(fn: (base: string) => Promise<void>) {
  const signer = new Signer(TEST_KEY);
  const db = await createTestDb();
  await db.insert(adminUsers).values({ slackUserId: "U_ADMIN", name: "Admin", role: "superadmin" });
  const app = express();
  app.use("/admin/api", requireAdmin(signer, db));
  app.get("/admin/api/me", (req, res) => res.json((req as never as { admin: unknown }).admin));
  app.post("/admin/api/thing", (_req, res) => res.status(204).end());
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("admin session", () => {
  it("rejects requests without a valid signed cookie", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/admin/api/me`)).status).toBe(401);
      const forged = Buffer.from(JSON.stringify({ userId: "U_EVIL", exp: Date.now() + 1e6 })).toString("base64url") + ".bogus";
      expect((await fetch(`${base}/admin/api/me`, { headers: { cookie: `${ADMIN_COOKIE}=${forged}` } })).status).toBe(401);
      const otherKey = new Signer(Buffer.alloc(32, 1)).sign({ userId: "U_ADMIN", name: "x" }, 60_000);
      expect((await fetch(`${base}/admin/api/me`, { headers: { cookie: `${ADMIN_COOKIE}=${otherKey}` } })).status).toBe(401);
      // A validly signed cookie for someone no longer on the roster is refused too.
      const removed = `${ADMIN_COOKIE}=${new Signer(TEST_KEY).sign({ userId: "U_GONE", name: "Gone" }, 60_000)}`;
      expect((await fetch(`${base}/admin/api/me`, { headers: { cookie: removed } })).status).toBe(403);
    });
  });

  it("accepts a valid cookie, and requires the CSRF header on mutations", async () => {
    await withServer(async (base) => {
      const cookie = `${ADMIN_COOKIE}=${new Signer(TEST_KEY).sign({ userId: "U_ADMIN", name: "Admin" }, 60_000)}`;
      const me = await fetch(`${base}/admin/api/me`, { headers: { cookie } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ userId: "U_ADMIN" });
      expect((await fetch(`${base}/admin/api/thing`, { method: "POST", headers: { cookie } })).status).toBe(403);
      expect((await fetch(`${base}/admin/api/thing`, { method: "POST", headers: { cookie, "x-requested-with": "fetch" } })).status).toBe(204);
    });
  });

  it("expires", async () => {
    const signer = new Signer(TEST_KEY);
    expect(signer.verify(signer.sign({ a: 1 }, -1))).toBeNull();
    expect(signer.verify(signer.sign({ a: 1 }, 1000))).toMatchObject({ a: 1 });
  });
});

describe("manual chatwoot agent linking", () => {
  it("lists agents across bridged accounts once per account, deduped by user id", async () => {
    const ctx = await makeContext();
    ctx.chatwootMock.listAgents.mockResolvedValue([
      { id: 7, name: "Sam", email: "sam@chatwoot.example" },
      { id: 8, name: "Kai", email: "KAI@chatwoot.example" },
    ]);
    await addBridge(ctx, { name: "second", channel: "C_TWO", accountId: 2 });
    await addBridge(ctx, { name: "same-account", channel: "C_THREE", accountId: 1 });
    const list = await listChatwootAgents(ctx);
    expect(list.map((a) => [a.id, a.accounts])).toEqual([
      [8, [1, 2]],
      [7, [1, 2]],
    ]);
    expect(ctx.chatwootMock.listAgents).toHaveBeenCalledTimes(2); // accounts 1 and 2, not 3 bridges
  });
});
