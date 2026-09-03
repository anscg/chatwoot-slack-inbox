import { encryptToken, decryptToken } from "./crypto.js";
import type { AppContext } from "./context.js";
import type { Agent } from "./db/schema.js";
import { log } from "./logger.js";
import { setAgentChatwootToken } from "./store.js";

/** Don't re-ask the Platform API for an agent we just failed to read. */
const RETRY_AFTER_MS = 10 * 60_000;
const lastFailure = new Map<number, number>();

/**
 * The Chatwoot access token to post this agent's Slack replies with, fetching it from the
 * Platform API on first use if an admin never attached one. Returns undefined when there is no
 * platform app configured, no matched Chatwoot user, or the app has no permission for them — the
 * caller then falls back to the bridge's service agent.
 */
export async function agentChatwootToken(ctx: AppContext, agent: Agent | undefined): Promise<string | undefined> {
  if (!agent) return undefined;
  if (agent.chatwootApiTokenEnc) return decryptToken(agent.chatwootApiTokenEnc, ctx.config.TOKEN_ENCRYPTION_KEY);
  if (!ctx.platform || !agent.chatwootAgentId) return undefined;
  const failedAt = lastFailure.get(agent.id);
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return undefined;

  try {
    const token = await ctx.platform.accessTokenFor(agent.chatwootAgentId);
    if (!token) {
      lastFailure.set(agent.id, Date.now());
      log.warn("platform app returned no access token for agent", { agentRow: agent.id, chatwootAgentId: agent.chatwootAgentId });
      return undefined;
    }
    await setAgentChatwootToken(ctx.db, agent.id, encryptToken(token, ctx.config.TOKEN_ENCRYPTION_KEY));
    lastFailure.delete(agent.id);
    log.info("attached chatwoot token from platform api", { agentRow: agent.id, chatwootAgentId: agent.chatwootAgentId });
    return token;
  } catch (err) {
    lastFailure.set(agent.id, Date.now());
    // A 404 here almost always means the platform app has no PlatformAppPermissible for this user.
    log.warn("could not fetch the agent's chatwoot token", { agentRow: agent.id, chatwootAgentId: agent.chatwootAgentId, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** Test seam: forget the negative cache. */
export function resetAgentTokenCache(): void {
  lastFailure.clear();
}
