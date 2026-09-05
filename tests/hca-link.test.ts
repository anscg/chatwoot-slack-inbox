import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agents } from "../src/db/schema.js";
import { Signer } from "../src/session.js";
import { registerSlackOAuth } from "../src/slack/oauth.js";
import { clearProfileCache } from "../src/slack/users.js";
import { upsertAgent } from "../src/store.js";
import { makeContext, TEST_KEY, type TestContext } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearProfileCache();
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
  ctx.slackMock.users.info.mockImplementation(async ({ user }: { user: string }) => ({
    ok: true,
    user: { id: user, real_name: "Alice", profile: { display_name: "Alice", email: "alice@slack.example" } },
  }));
  return ctx;
}

/** Walk the Hack Club half and hand back the state Slack would be sent away with. */
async function hcaHalf(base: string): Promise<string> {
  const res = await fetch(`${base}/link/hca/callback?code=abc&state=${encodeURIComponent(new Signer(TEST_KEY).sign({ purpose: "link-hca" }, 60_000))}`, {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://slack.com/oauth/v2/authorize");
  return to.searchParams.get("state")!;
}

describe("linking an account, Hack Club Auth first", () => {
  it("starts at Hack Club Auth, because that is the email Chatwoot knows people by", async () => {
    const ctx = await setup();
    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location")!);
      expect(to.origin + to.pathname).toBe("https://auth.hackclub.com/oauth/authorize");
      expect(to.searchParams.get("client_id")).toBe("hca-client");
      expect(to.searchParams.get("redirect_uri")).toBe("https://bridge.test/link/hca/callback");
      expect(to.searchParams.get("scope")).toBe("openid profile");
    });
  });

  it("goes straight to Slack when no Hack Club Auth app is configured", async () => {
    const ctx = await makeContext();
    await withServer(ctx, async (base) => {
      const res = await fetch(`${base}/link`, { redirect: "manual" });
      const to = new URL(res.headers.get("location")!);
      expect(to.origin + to.pathname).toBe("https://slack.com/oauth/v2/authorize");
      expect((await fetch(`${base}/link/hca/callback?code=abc`)).status).toBe(404);
    });
  });

  it("matches on the Hack Club email in preference to the Slack one, and records where it came from", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    const tokenBody = vi.fn();
    stubHca({ sub: "hca-1", email: "alice@hackclub.com", email_verified: true, slack_id: "U_ALICE" }, tokenBody);

    await withServer(ctx, async (base) => {
      const state = await hcaHalf(base);
      const res = await fetch(`${base}/link/callback?code=slack-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("all set");
      // Nothing internal: not the agent's name in Chatwoot, not tokens, not the panel.
      expect(body).not.toMatch(/token|control panel|Chatwoot/i);
    });

    expect(tokenBody.mock.calls[0]![0].get("code")).toBe("abc");
    const [row] = await ctx.db.select().from(agents);
    expect(row).toMatchObject({ slackUserId: "U_ALICE", chatwootAgentId: 9, email: "alice@hackclub.com", emailSource: "chatwoot" });
    expect(row!.slackUserTokenEnc).toBeTruthy();
  });

  it("keeps the Hack Club email even when it matches nobody, so nobody is invited at their Slack address", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([]);
    stubHca({ email: "alice@hackclub.com", email_verified: true, slack_id: "U_ALICE" });

    await withServer(ctx, async (base) => {
      const state = await hcaHalf(base);
      const body = await (await fetch(`${base}/link/callback?code=slack-code&state=${encodeURIComponent(state)}`)).text();
      expect(body).toContain("connected");
      expect(body).not.toMatch(/token|control panel|Chatwoot/i);
    });

    const [row] = await ctx.db.select().from(agents);
    expect(row).toMatchObject({ email: "alice@hackclub.com", emailSource: "hackclub", chatwootAgentId: null });
  });

  it("falls back to the Slack address when Hack Club Auth has no verified email", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 4, name: "Alice S", email: "alice@slack.example" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: false });

    await withServer(ctx, async (base) => {
      const state = await hcaHalf(base);
      expect((await fetch(`${base}/link/callback?code=slack-code&state=${encodeURIComponent(state)}`)).status).toBe(200);
    });

    expect((await ctx.db.select().from(agents))[0]).toMatchObject({ chatwootAgentId: 4, email: "alice@slack.example", emailSource: "chatwoot" });
  });

  it("refuses when the Hack Club account belongs to a different Slack user", async () => {
    const ctx = await setup();
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: true, slack_id: "U_MALLORY" });

    await withServer(ctx, async (base) => {
      const state = await hcaHalf(base);
      expect((await fetch(`${base}/link/callback?code=slack-code&state=${encodeURIComponent(state)}`)).status).toBe(403);
    });

    expect(await ctx.db.select().from(agents)).toHaveLength(0);
  });

  it("rejects a state that is not ours", async () => {
    const ctx = await setup();
    const forged = encodeURIComponent(new Signer(Buffer.alloc(32, 1)).sign({ purpose: "link" }, 60_000));
    await withServer(ctx, async (base) => {
      expect((await fetch(`${base}/link/callback?code=abc&state=${forged}`)).status).toBe(400);
      expect((await fetch(`${base}/link/hca/callback?code=abc&state=${forged}`)).status).toBe(400);
    });
  });
});

/** The second chance offered to somebody whose link finished without a match. */
describe("signing in with Hack Club Auth after the fact", () => {
  const retry = (slackUserId = "U_ALICE") => encodeURIComponent(new Signer(TEST_KEY).sign({ purpose: "link-hca-retry", slackUserId }, 60_000));

  it("sends them to Hack Club Auth carrying the account they linked, then matches on that email", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_ALICE", email: "alice@slack.example", emailSource: "slack" });
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: true, slack_id: "U_ALICE" });

    await withServer(ctx, async (base) => {
      const hop = await fetch(`${base}/link/hca?t=${retry()}`, { redirect: "manual" });
      const state = new URL(hop.headers.get("location")!).searchParams.get("state")!;
      expect(new Signer(TEST_KEY).verify<{ slackUserId: string }>(state)?.slackUserId).toBe("U_ALICE");
      const body = await (await fetch(`${base}/link/hca/callback?code=abc&state=${encodeURIComponent(state)}`)).text();
      expect(body).toContain("all set");
    });

    expect((await ctx.db.select().from(agents))[0]).toMatchObject({ chatwootAgentId: 9, email: "alice@hackclub.com", emailSource: "chatwoot" });
  });

  it("refuses a Hack Club account that belongs to somebody else", async () => {
    const ctx = await setup();
    await upsertAgent(ctx.db, { slackUserId: "U_ALICE", email: "alice@slack.example" });
    ctx.chatwootMock.listAgents.mockResolvedValue([{ id: 9, name: "Alice H", email: "alice@hackclub.com" }]);
    stubHca({ email: "alice@hackclub.com", email_verified: true, slack_id: "U_MALLORY" });

    await withServer(ctx, async (base) => {
      const hop = await fetch(`${base}/link/hca?t=${retry()}`, { redirect: "manual" });
      const state = new URL(hop.headers.get("location")!).searchParams.get("state")!;
      expect((await fetch(`${base}/link/hca/callback?code=abc&state=${encodeURIComponent(state)}`)).status).toBe(403);
    });

    expect((await ctx.db.select().from(agents))[0]!.chatwootAgentId).toBeNull();
  });

  it("rejects a carrier token that is not ours", async () => {
    const ctx = await setup();
    const forged = encodeURIComponent(new Signer(Buffer.alloc(32, 1)).sign({ purpose: "link-hca-retry", slackUserId: "U_MALLORY" }, 60_000));
    await withServer(ctx, async (base) => {
      expect((await fetch(`${base}/link/hca?t=${forged}`)).status).toBe(400);
    });
  });
});
