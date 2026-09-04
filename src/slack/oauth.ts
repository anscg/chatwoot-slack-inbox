import type { Request, Response, Router } from "express";
import { agentChatwootToken } from "../agents.js";
import type { AppContext } from "../context.js";
import { encryptToken } from "../crypto.js";
import { hcaAuthorizeUrl, hcaClient, hcaProfile } from "../hca.js";
import { log } from "../logger.js";
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, Signer, type AdminSession } from "../session.js";
import { upsertAgent } from "../store.js";
import { getSlackProfile } from "./users.js";

const STATE_TTL_MS = 10 * 60_000;

interface LinkResult {
  match: { id: number; name: string } | undefined;
  /** True when we hold a Chatwoot token for them, so their Slack replies carry their own face. */
  attributed: boolean;
}

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
  const hcaRedirect = `${config.PUBLIC_URL}/link/hca/callback`;
  const hca = hcaClient(config);
  const adminRedirect = `${config.PUBLIC_URL}/admin/callback`;
  const secureCookie = config.PUBLIC_URL.startsWith("https://");

  // ---- Agent linking: user scope chat:write so replies can be posted as the agent ----

  const USER_SCOPES = "chat:write,files:write";

  /** Exchange an OAuth code for the authorizing user's id + user token. */
  async function exchangeCode(code: string, redirectUri: string): Promise<{ userId: string; userToken: string }> {
    const token = await ctx.hub.oauth.v2.access({ client_id: config.SLACK_CLIENT_ID, client_secret: config.SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri });
    const userId = token.authed_user?.id;
    const userToken = token.authed_user?.access_token;
    if (!userId || !userToken) throw new Error("oauth response missing authed_user token");
    return { userId, userToken };
  }

  /**
   * Store the user token, match a Chatwoot agent by email, and — when a platform app is
   * configured — fetch that agent's own Chatwoot token so both directions are attributed to them.
   */
  async function linkAgent(userId: string, userToken: string, email: string | undefined): Promise<LinkResult> {
    const match = await matchChatwootAgentByEmail(ctx, email);
    const row = await upsertAgent(ctx.db, {
      slackUserId: userId,
      email: email ?? null,
      slackUserTokenEnc: encryptToken(userToken, config.TOKEN_ENCRYPTION_KEY),
      ...(match ? { chatwootAgentId: match.id } : {}),
    });
    const attributed = Boolean(await agentChatwootToken(ctx, row));
    log.info("agent linked slack account", { slackUserId: userId, matched: Boolean(match), attributed });
    return { match, attributed };
  }

  router.get("/link", (_req: Request, res: Response) => {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("user_scope", USER_SCOPES);
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
      const { userId, userToken } = await exchangeCode(String(req.query.code ?? ""), linkRedirect);
      const profile = await getSlackProfile(ctx.hub, userId);
      const { match, attributed } = await linkAgent(userId, userToken, profile.email);

      const matchNote = !match
        ? `<p><strong>No Chatwoot agent with the email ${profile.email ?? "(none on your Slack profile)"} was found.</strong> Chatwoot replies will still post to Slack as you, but Slack replies count as contact messages until an admin attaches your Chatwoot API token in the control panel.</p>${hcaOffer(userId)}`
        : attributed
          ? `<p>Matched to Chatwoot agent <strong>${match.name}</strong> by email. Your Slack replies will be attributed to you in Chatwoot; Chatwoot replies will post to Slack as you.</p>`
          : `<p>Matched to Chatwoot agent <strong>${match.name}</strong> by email. Chatwoot replies will post to Slack as you. Your Slack replies are posted by the bridge's service agent with your name on them until an admin attaches your Chatwoot API token in the control panel.</p>`;
      res.send(page("Slack account linked", matchNote + "<p>You can close this tab.</p>"));
    } catch (err) {
      log.error("link callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Link failed", "<p>Something went wrong talking to Slack. <a href='/link'>Try again</a>.</p>"));
    }
  });

  /**
   * The Slack email found nobody. A Hack Club account's email is often not the one on their Slack
   * profile, so offer to ask Hack Club Auth — the same sign-in Chatwoot uses — which email that is.
   */
  function hcaOffer(slackUserId: string): string {
    if (!hca) return "";
    const token = encodeURIComponent(signer.sign({ purpose: "link-hca", slackUserId }, STATE_TTL_MS));
    return `<p>Do you sign in to Chatwoot with Hack Club Auth? Your email there is probably not the one on your Slack profile.
<a href="/link/hca?t=${token}">Sign in with Hack Club Auth</a> and I'll match you by that email instead.</p>`;
  }

  router.get("/link/hca", (req: Request, res: Response) => {
    if (!hca) {
      res.status(404).send(page("Not available", "<p>This bridge has no Hack Club Auth app configured.</p>"));
      return;
    }
    const carried = signer.verify<{ purpose: string; slackUserId: string }>(String(req.query.t ?? ""));
    if (!carried || carried.purpose !== "link-hca") {
      res.status(400).send(page("Link failed", "<p>That link has expired. <a href='/link'>Start again</a>.</p>"));
      return;
    }
    const state = signer.sign({ purpose: "link-hca", slackUserId: carried.slackUserId }, STATE_TTL_MS);
    res.redirect(hcaAuthorizeUrl(hca, hcaRedirect, state));
  });

  router.get("/link/hca/callback", async (req: Request, res: Response) => {
    if (!hca) return void res.status(404).send(page("Not available", "<p>This bridge has no Hack Club Auth app configured.</p>"));
    const state = signer.verify<{ purpose: string; slackUserId: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "link-hca") {
      res.status(400).send(page("Link failed", "<p>Invalid or expired state. <a href='/link'>Start again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Link cancelled", `<p>Hack Club Auth said: <code>${String(req.query.error)}</code>. <a href='/link'>Start again</a>.</p>`));
      return;
    }
    try {
      const profile = await hcaProfile(hca, String(req.query.code ?? ""), hcaRedirect);
      // Hack Club Auth knows which Slack account this is. If it names a different one, the person
      // in front of us is not the one who just linked, and matching them would hand over someone
      // else's Chatwoot identity.
      if (profile.slackId && profile.slackId !== state.slackUserId) {
        log.warn("hca sign-in is for a different slack account", { linked: state.slackUserId, hca: profile.slackId });
        res.status(403).send(page("Different account", "<p>That Hack Club account belongs to a different Slack user. <a href='/link'>Start again</a> from the Slack account you want to link.</p>"));
        return;
      }
      if (!profile.email || profile.emailVerified === false) {
        res.status(400).send(page("No verified email", "<p>Hack Club Auth did not give a verified email for that account, so there is nothing to match on.</p>"));
        return;
      }
      const match = await matchChatwootAgentByEmail(ctx, profile.email);
      if (!match) {
        res.send(
          page(
            "Still no match",
            `<p>No Chatwoot agent has the email <code>${profile.email}</code> either. Your Slack account is still linked, so Chatwoot replies post to Slack as you. Ask an admin to attach your Chatwoot API token in the control panel.</p>`,
          ),
        );
        return;
      }
      const row = await upsertAgent(ctx.db, { slackUserId: state.slackUserId, email: profile.email, chatwootAgentId: match.id });
      const attributed = Boolean(await agentChatwootToken(ctx, row));
      log.info("agent matched by hack club auth email", { slackUserId: state.slackUserId, chatwootAgentId: match.id, attributed });
      res.send(
        page(
          "Matched",
          `<p>Matched to Chatwoot agent <strong>${match.name}</strong> by your Hack Club Auth email.</p>` +
            (attributed
              ? "<p>Your Slack replies will be attributed to you in Chatwoot.</p>"
              : "<p>Your Slack replies are posted by the bridge's service agent with your name on them until an admin attaches your Chatwoot API token.</p>") +
            "<p>You can close this tab.</p>",
        ),
      );
    } catch (err) {
      log.error("hca callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Link failed", "<p>Something went wrong talking to Hack Club Auth. <a href='/link'>Start again</a>.</p>"));
    }
  });

  // ---- Admin sign-in: same OAuth v2 flow as /link (Slack forbids mixing OpenID scopes with
  // other user scopes in one app install). Signing in also links the admin's account. ----

  router.get("/admin/login", (_req: Request, res: Response) => {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("user_scope", USER_SCOPES);
    url.searchParams.set("redirect_uri", adminRedirect);
    url.searchParams.set("state", signer.sign({ purpose: "admin" }, STATE_TTL_MS));
    res.redirect(url.toString());
  });

  router.get("/admin/callback", async (req: Request, res: Response) => {
    const state = signer.verify<{ purpose: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "admin") {
      res.status(400).send(page("Sign-in failed", "<p>Invalid or expired state. <a href='/admin/login'>Try again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Sign-in cancelled", `<p>Slack said: <code>${String(req.query.error)}</code>. <a href='/admin/login'>Try again</a>.</p>`));
      return;
    }
    try {
      const { userId, userToken } = await exchangeCode(String(req.query.code ?? ""), adminRedirect);
      if (!config.ADMIN_SLACK_USER_IDS.includes(userId)) {
        log.warn("admin sign-in denied", { userId });
        res.status(403).send(page("Not allowed", `<p>Slack user <code>${userId}</code> is not in <code>ADMIN_SLACK_USER_IDS</code>.</p>`));
        return;
      }
      const profile = await getSlackProfile(ctx.hub, userId);
      await linkAgent(userId, userToken, profile.email); // admins are usually agents too; no harm otherwise
      const session: AdminSession = { userId, name: profile.name };
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
