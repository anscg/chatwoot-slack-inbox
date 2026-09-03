import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatwootToken, resetAgentTokenCache } from "../src/agents.js";
import { ChatwootPlatformClient } from "../src/chatwoot/platform.js";
import { decryptToken, encryptToken } from "../src/crypto.js";
import { agents } from "../src/db/schema.js";
import { acceptSlackMessage, JOB_SLACK_MESSAGE, relaySlackMessage } from "../src/slack/events.js";
import { flush, makeContext, TEST_KEY, type TestContext } from "./helpers.js";

const msg = (over: Record<string, unknown> = {}) => ({
  type: "message" as const,
  channel: "C_HELP",
  ts: "1700000000.000100",
  user: "U_ALICE",
  text: "help please",
  ...over,
});

/** A platform client whose fetch returns one canned user payload. */
function platformStub(payload: unknown, status = 200): { client: ChatwootPlatformClient; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  });
  return { client: new ChatwootPlatformClient("https://chatwoot.test", "platform-token", fetchFn as unknown as typeof fetch), calls };
}

describe("automatic agent token attachment", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    resetAgentTokenCache();
    ctx = await makeContext();
    ctx.retry.register(JOB_SLACK_MESSAGE, (p) => relaySlackMessage(ctx, p as never, 0));
  });

  it("fetches and stores the agent's own token on first use, then reuses it", async () => {
    const { client, calls } = platformStub({ id: 7, email: "agent@example.com", access_token: "her-token" });
    ctx.platform = client;
    const [agent] = await ctx.db.insert(agents).values({ slackUserId: "U_AGENT", chatwootAgentId: 7 }).returning();

    expect(await agentChatwootToken(ctx, agent!)).toBe("her-token");
    expect(calls).toEqual(["https://chatwoot.test/platform/api/v1/users/7"]);

    const [stored] = await ctx.db.select().from(agents);
    expect(decryptToken(stored!.chatwootApiTokenEnc!, TEST_KEY)).toBe("her-token");
    // Second call reads the stored token instead of the Platform API.
    expect(await agentChatwootToken(ctx, stored!)).toBe("her-token");
    expect(calls).toHaveLength(1);
  });

  it("attributes a Slack reply to the agent without an admin attaching anything", async () => {
    const { client } = platformStub({ id: 7, access_token: "her-token" });
    ctx.platform = client;
    await ctx.db.insert(agents).values({ slackUserId: "U_AGENT", chatwootAgentId: 7 });

    await acceptSlackMessage(ctx, "Ev1", msg());
    await flush();
    await acceptSlackMessage(ctx, "Ev2", msg({ ts: "1700000000.000500", thread_ts: "1700000000.000100", user: "U_AGENT", text: "try this" }));
    await flush();

    expect(ctx.chatwootMock.createAgentMessage).toHaveBeenCalledWith(42, "try this", { apiToken: "her-token", attachments: [] });
  });

  it("falls back to the service agent, and stops asking, when the platform app has no permission", async () => {
    const { client, calls } = platformStub({ message: "Resource could not be found" }, 404);
    ctx.platform = client;
    const [agent] = await ctx.db.insert(agents).values({ slackUserId: "U_AGENT", chatwootAgentId: 7 }).returning();

    expect(await agentChatwootToken(ctx, agent!)).toBeUndefined();
    expect(await agentChatwootToken(ctx, agent!)).toBeUndefined();
    expect(calls).toHaveLength(1); // negative cache
  });

  it("leaves an already-attached token alone", async () => {
    const { client, calls } = platformStub({ id: 7, access_token: "from-platform" });
    ctx.platform = client;
    const [agent] = await ctx.db
      .insert(agents)
      .values({ slackUserId: "U_AGENT", chatwootAgentId: 7, chatwootApiTokenEnc: encryptToken("hand-attached", TEST_KEY) })
      .returning();

    expect(await agentChatwootToken(ctx, agent!)).toBe("hand-attached");
    expect(calls).toHaveLength(0);
  });

  it("does nothing without a platform app configured", async () => {
    const [agent] = await ctx.db.insert(agents).values({ slackUserId: "U_AGENT", chatwootAgentId: 7 }).returning();
    expect(await agentChatwootToken(ctx, agent!)).toBeUndefined();
  });
});
