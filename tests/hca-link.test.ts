import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agents } from "../src/db/schema.js";
import { Signer } from "../src/session.js";
import { registerSlackOAuth } from "../src/slack/oauth.js";
import { upsertAgent } from "../src/store.js";
import { makeContext, TEST_KEY, type TestContext } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer Hack Club Auth's endpoints; everything else (our own test server) goes out for real. */
function stubHca(userinfo: Record<string, unknown>, onToken?: (body: URLSearchParams) => void): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://auth.hackclub.com/oauth/token") {
      onToken?.(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "hca-access" }), { headers: { "content-type": "application/json" } });
    }
    if (url === "https://auth.hackclub.com/oauth/userinfo") {
      return new Response(JSON.stringify(userinfo), { headers: { "content-type": "application/json" } });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

async function withServer(ctx: TestContext, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  registerSlackOAuth(app, ctx);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function setup(): Promise<TestContext> {
  const ctx = await makeContext({ config: { HCA_CLIENT_ID: "hca-client", HCA_CLIENT_SECRET: "hca-secret", HCA_ISSUER: "https://auth.hackclub.com" } });
  await upsertAgent(ctx.db, { slackUserId: "U_ALICE", email: "alice@slack.example" });
  return ctx;
}

/** The signed value the result page hands out, which is also the shape of the OAuth state. */
const signed = (slackUserId = "U_ALICE") => encodeURIComponent(new Signer(TEST_KEY).sign({ purpose: "link-hca", slackUserId }, 60_000));

describe("matching an agent by their Hack Club Auth email", () => {
  it("sends them to Hack Club Auth, carrying the Slack account they just linked", async () => {
    const ctx = await setup();
    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link/hca?t=${signed()}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location")!);
      expect(to.origin + to.pathname).toBe("https://auth.hackclub.com/oauth/authorize");
      expect(to.searchParams.get("client_id")).toBe("hca-client");
      expect(to.searchParams.get("redirect_uri")).toBe("https://bridge.test/link/hca/callback");
      expect(to.searchParams.get("scope")).toBe("openid profile");
      expect(new Signer(TEST_KEY).verify<{ slackUserId: string }>(to.searchParams.get("state")!)?.slackUserId).toBe("U_ALICE");
    });
  });

  it("matches the Chatwoot agent with that email and records it", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    const tokenBody = vi.fn();
    stubHca({ sub: "hca-1", email: "alice@hackclub.com", email_verified: true, slack_id: "U_ALICE" }, tokenBody);

    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link/hca/callback?code=abc&state=${signed()}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Alice H");
    });

    expect(tokenBody.mock.calls[0]![0].get("code")).toBe("abc");
    const [row] = await ctx.db.select().from(agents);
    expect(row).toMatchObject({ slackUserId: "U_ALICE", chatwootAgentId: 9, email: "alice@hackclub.com" });
  });

  it("says so plainly when that email is not an agent either, and changes nothing", async () => {
    const ctx = await setup();
    stubHca({ email: "nobody@hackclub.com", email_verified: true });

    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link/hca/callback?code=abc&state=${signed()}`);
      expect(await res.text()).toContain("Still no match");
    });

    expect((await ctx.db.select().from(agents))[0]!.chatwootAgentId).toBeNull();
  });

  it("refuses when the Hack Club account belongs to a different Slack user", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: true, slack_id: "U_MALLORY" });

    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link/hca/callback?code=abc&state=${signed()}`);
      expect(res.status).toBe(403);
    });

    expect((await ctx.db.select().from(agents))[0]!.chatwootAgentId).toBeNull();
  });

  it("will not match on an unverified email", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: false });

    await withServer(ctx, async (base) => {
      expect((await fetch(`${base}/link/hca/callback?code=abc&state=${signed()}`)).status).toBe(400);
    });

    expect((await ctx.db.select().from(agents))[0]!.chatwootAgentId).toBeNull();
  });

  it("turns the whole flow off when no Hack Club Auth app is configured", async () => {
    const ctx = await makeContext();
    await withServer(ctx, async (base) => {
      expect((await fetch(`${base}/link/hca?t=${signed()}`)).status).toBe(404);
      expect((await fetch(`${base}/link/hca/callback?code=abc&state=${signed()}`)).status).toBe(404);
    });
  });

  it("rejects a carrier or state that is not ours", async () => {
    const ctx = await setup();
    const forged = encodeURIComponent(new Signer(Buffer.alloc(32, 1)).sign({ purpose: "link-hca", slackUserId: "U_MALLORY" }, 60_000));
    await withServer(ctx, async (base) => {
      expect((await fetch(`${base}/link/hca?t=${forged}`)).status).toBe(400);
      expect((await fetch(`${base}/link/hca/callback?code=abc&state=${forged}`)).status).toBe(400);
    });
  });
});
