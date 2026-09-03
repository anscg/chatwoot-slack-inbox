import type { Request, Response, Router } from "express";
import type { AppContext } from "../context.js";
import { encryptToken } from "../crypto.js";
import { log } from "../logger.js";
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, Signer, type AdminSession } from "../session.js";
import { upsertAgent } from "../store.js";
import { getSlackProfile } from "./users.js";

const STATE_TTL_MS = 10 * 60_000;

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}</style>
<h1>${title}</h1>${body}`;
}

/** Find the Chatwoot agent (user) with this email in any bridged account. */
export async function matchChatwootAgentByEmail(ctx: AppContext, email: string | undefined): Promise<{ id: number; name: string } | undefined> {
  if (!email) return undefined;
  const wanted = email.toLowerCase();
  const seenAccounts = new Set<number>();
  for (const bridge of ctx.bridges.all()) {
    if (seenAccounts.has(bridge.row.chatwootAccountId)) continue;
    seenAccounts.add(bridge.row.chatwootAccountId);
    try {
      const agents = await bridge.chatwoot.listAgents();
      const hit = agents.find((a) => a.email?.toLowerCase() === wanted);
      if (hit) return { id: hit.id, name: hit.name };
    } catch (err) {
      log.warn("listAgents failed while matching email", { bridge: bridge.row.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return undefined;
}

export function registerSlackOAuth(router: Router, ctx: AppContext): void {
  const { config } = ctx;
  const signer = new Signer(config.TOKEN_ENCRYPTION_KEY);
  const linkRedirect = `${config.PUBLIC_URL}/link/callback`;
  const adminRedirect = `${config.PUBLIC_URL}/admin/callback`;
  const secureCookie = config.PUBLIC_URL.startsWith("https://");

  // ---- Agent linking: user scope chat:write so replies can be posted as the agent ----

  router.get("/link", (_req: Request, res: Response) => {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("user_scope", "chat:write,files:write");
    url.searchParams.set("redirect_uri", linkRedirect);
    url.searchParams.set("state", signer.sign({ purpose: "link" }, STATE_TTL_MS));
    res.redirect(url.toString());
  });

  router.get("/link/callback", async (req: Request, res: Response) => {
    const state = signer.verify<{ purpose: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "link") {
      res.status(400).send(page("Link failed", "<p>Invalid or expired state. <a href='/link'>Try again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Link cancelled", `<p>Slack said: <code>${String(req.query.error)}</code>. <a href='/link'>Try again</a>.</p>`));
      return;
    }
    try {
      const token = await ctx.hub.oauth.v2.access({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code: String(req.query.code ?? ""),
        redirect_uri: linkRedirect,
      });
      const userId = token.authed_user?.id;
      const userToken = token.authed_user?.access_token;
      if (!userId || !userToken) throw new Error("oauth response missing authed_user token");

      const profile = await getSlackProfile(ctx.hub, userId);
      const match = await matchChatwootAgentByEmail(ctx, profile.email);
      await upsertAgent(ctx.db, {
        slackUserId: userId,
        email: profile.email ?? null,
        slackUserTokenEnc: encryptToken(userToken, config.TOKEN_ENCRYPTION_KEY),
        ...(match ? { chatwootAgentId: match.id } : {}),
      });
      log.info("agent linked slack account", { slackUserId: userId, matched: Boolean(match) });

      const matchNote = match
        ? `<p>Matched to Chatwoot agent <strong>${match.name}</strong> by email. Your Slack replies will be attributed to you in Chatwoot; Chatwoot replies will post to Slack as you.</p>`
        : `<p><strong>No Chatwoot agent with the email ${profile.email ?? "(none on your Slack profile)"} was found.</strong> Chatwoot replies will still post to Slack as you, but Slack replies count as contact messages until an admin attaches your Chatwoot API token in the control panel.</p>`;
      res.send(page("Slack account linked", matchNote + "<p>You can close this tab.</p>"));
    } catch (err) {
      log.error("link callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Link failed", "<p>Something went wrong talking to Slack. <a href='/link'>Try again</a>.</p>"));
    }
  });

  // ---- Admin sign-in: Sign in with Slack (OpenID Connect), allow-listed user IDs only ----

  router.get("/admin/login", (_req: Request, res: Response) => {
    const nonce = signer.sign({ n: Math.random() }, STATE_TTL_MS).slice(-24);
    const url = new URL("https://slack.com/openid/connect/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("redirect_uri", adminRedirect);
    url.searchParams.set("state", signer.sign({ purpose: "admin", nonce }, STATE_TTL_MS));
    url.searchParams.set("nonce", nonce);
    res.redirect(url.toString());
  });

  router.get("/admin/callback", async (req: Request, res: Response) => {
    const state = signer.verify<{ purpose: string; nonce: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "admin") {
      res.status(400).send(page("Sign-in failed", "<p>Invalid or expired state. <a href='/admin/login'>Try again</a>.</p>"));
      return;
    }
    try {
      const tok = await ctx.hub.openid.connect.token({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code: String(req.query.code ?? ""),
        redirect_uri: adminRedirect,
      });
      const claims = decodeIdToken(tok.id_token);
      if (claims.nonce !== state.nonce || claims.aud !== config.SLACK_CLIENT_ID) throw new Error("id_token nonce/audience mismatch");
      const userId = claims["https://slack.com/user_id"];
      if (!userId) throw new Error("id_token missing user id");
      if (!config.ADMIN_SLACK_USER_IDS.includes(userId)) {
        log.warn("admin sign-in denied", { userId });
        res.status(403).send(page("Not allowed", `<p>Slack user <code>${userId}</code> is not in <code>ADMIN_SLACK_USER_IDS</code>.</p>`));
        return;
      }
      const session: AdminSession = { userId, name: claims.name ?? userId };
      res.cookie(ADMIN_COOKIE, signer.sign(session, ADMIN_SESSION_TTL_MS), {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie,
        maxAge: ADMIN_SESSION_TTL_MS,
        path: "/",
      });
      res.redirect("/admin/");
    } catch (err) {
      log.error("admin callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Sign-in failed", "<p>Something went wrong talking to Slack. <a href='/admin/login'>Try again</a>.</p>"));
    }
  });

  router.post("/admin/logout", (_req: Request, res: Response) => {
    res.clearCookie(ADMIN_COOKIE, { path: "/" });
    res.redirect("/admin/");
  });
}

interface IdTokenClaims {
  aud?: string;
  nonce?: string;
  name?: string;
  email?: string;
  "https://slack.com/user_id"?: string;
  "https://slack.com/team_id"?: string;
}

/**
 * The id_token came straight from Slack over TLS in the code exchange, so we trust
 * its origin; we still check nonce/aud. (No JWKS fetch needed for this flow.)
 */
function decodeIdToken(idToken: string | undefined): IdTokenClaims {
  if (!idToken) throw new Error("no id_token in response");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
}
