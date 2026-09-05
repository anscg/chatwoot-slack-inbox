import { eq } from "drizzle-orm";
import type { Request, Response, Router } from "express";
import { agentChatwootToken } from "../agents.js";
import { loadActor } from "../admin/access.js";
import type { AppContext } from "../context.js";
import { encryptToken } from "../crypto.js";
import { adminUsers, type Agent } from "../db/schema.js";
import { hcaAuthorizeUrl, hcaClient, hcaProfile } from "../hca.js";
import { log } from "../logger.js";
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, Signer, type AdminSession } from "../session.js";
import { provisionLinkedHelper } from "../helpers.js";
import { upsertAgent } from "../store.js";
import { getSlackProfile } from "./users.js";

const STATE_TTL_MS = 10 * 60_000;

/** Which side an address came from, in the order we trust it. See `agents.emailSource`. */
type EmailSource = "chatwoot" | "hackclub" | "slack";

interface ChatwootMatch {
  id: number;
  name: string;
  email?: string;
}

interface LinkResult {
  match: ChatwootMatch | undefined;
  row: Agent;
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}code{background:#f2f2f2;padding:.1em .3em;border-radius:3px}.bad{color:#a4232b;font-weight:600}</style>
<h1>${esc(title)}</h1>${body}`;
}

/**
 * What somebody who just linked is told. Nothing here names Chatwoot tokens, the control panel or
 * the service agent: the person reading it cannot act on any of that, and most of them have no
 * business knowing it exists. Anything left to do is somebody else's job and is already visible on
 * the helper roster.
 */
const DONE = "<p>You can close this tab.</p>";
const ALL_SET = `<p>Your Slack account is connected. Replies you write in a ticket thread go back to whoever asked, under your name.</p>${DONE}`;
/**
 * Not a milder kind of success. Somebody in this state who answers a ticket has their reply filed
 * as the *asker's* own message, so saying "your replies still get through" would be telling them
 * to go and do the one thing that makes a mess. Say it failed, and say not to answer anything yet.
 */
const NOT_SET_UP =
  `<p class="bad">Your Slack sign-in worked, but we could not set you up to answer tickets.</p>` +
  `<p>Please don't answer any tickets yet: until this is fixed, what you write would not be recorded as coming from you.</p>` +
  `<p>Tell whoever runs this that your account could not be set up, and they will finish it off.</p>`;

/** Find the Chatwoot agent (user) with this email in any bridged account. */
export async function matchChatwootAgentByEmail(ctx: AppContext, email: string | undefined): Promise<ChatwootMatch | undefined> {
  if (!email) return undefined;
  const wanted = email.toLowerCase();
  const seenAccounts = new Set<number>();
  for (const bridge of ctx.bridges.all()) {
    if (seenAccounts.has(bridge.row.chatwootAccountId)) continue;
    seenAccounts.add(bridge.row.chatwootAccountId);
    try {
      const agents = await bridge.chatwoot.listAgents();
      const hit = agents.find((a) => a.email?.toLowerCase() === wanted);
      if (hit) return { id: hit.id, name: hit.name, email: hit.email };
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

  // ---- Agent linking ----
  //
  // Two sign-ins, in this order:
  //   1. Hack Club Auth, which is what Chatwoot itself signs people in with, so its email is the
  //      one Chatwoot knows them by. Their Slack profile address is usually a different one, and
  //      matching on it finds nobody — or worse, invites them a second, duplicate account.
  //   2. Slack, for the user token that lets their replies be posted as them.
  // Hack Club Auth is skippable and skipped entirely when this deployment has no app for it; the
  // Slack address is then the only thing left to match on.

  const USER_SCOPES = "chat:write,files:write";

  /** Where a Slack sign-in starts, carrying whatever the Hack Club step already established. */
  function slackAuthorizeUrl(redirectUri: string, state: Record<string, unknown>): string {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("user_scope", USER_SCOPES);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", signer.sign(state, STATE_TTL_MS));
    return url.toString();
  }

  /** Exchange an OAuth code for the authorizing user's id + user token. */
  async function exchangeCode(code: string, redirectUri: string): Promise<{ userId: string; userToken: string }> {
    const token = await ctx.hub.oauth.v2.access({ client_id: config.SLACK_CLIENT_ID, client_secret: config.SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri });
    const userId = token.authed_user?.id;
    const userToken = token.authed_user?.access_token;
    if (!userId || !userToken) throw new Error("oauth response missing authed_user token");
    return { userId, userToken };
  }

  /**
   * Store what we now know about somebody: the Chatwoot agent their address matches, the address
   * itself and where it came from, and — when a platform app is configured — that agent's own
   * Chatwoot token, so both directions are attributed to them.
   *
   * The Hack Club address is tried first and kept even when it matches nothing, because it is
   * still the address Chatwoot would have to invite; keeping the Slack one instead is what
   * produces duplicate accounts.
   */
  async function linkAgent(
    userId: string,
    opts: { userToken?: string; hcaEmail?: string; slackEmail?: string },
  ): Promise<LinkResult> {
    const slackEmail = opts.slackEmail?.toLowerCase() === opts.hcaEmail?.toLowerCase() ? undefined : opts.slackEmail;
    const match = (await matchChatwootAgentByEmail(ctx, opts.hcaEmail)) ?? (await matchChatwootAgentByEmail(ctx, slackEmail));
    const email = match?.email ?? opts.hcaEmail ?? opts.slackEmail;
    const emailSource: EmailSource | undefined = match ? "chatwoot" : opts.hcaEmail ? "hackclub" : opts.slackEmail ? "slack" : undefined;
    const row = await upsertAgent(ctx.db, {
      slackUserId: userId,
      ...(email ? { email, emailSource } : {}),
      ...(opts.userToken ? { slackUserTokenEnc: encryptToken(opts.userToken, config.TOKEN_ENCRYPTION_KEY) } : {}),
      ...(match ? { chatwootAgentId: match.id } : {}),
    });
    const attributed = Boolean(await agentChatwootToken(ctx, row));
    log.info("agent linked slack account", { slackUserId: userId, matched: Boolean(match), emailSource, attributed });
    // They may have linked because a helper channel asked them to; finish that off now. Never let
    // it break the link itself — the person is standing in front of the callback page.
    await provisionLinkedHelper(ctx, userId).catch((err) =>
      log.warn("could not follow up a link on the helper rosters", { slackUserId: userId, error: err instanceof Error ? err.message : String(err) }),
    );
    return { match, row };
  }

  router.get("/link", (_req: Request, res: Response) => {
    if (!hca) return void res.redirect(slackAuthorizeUrl(linkRedirect, { purpose: "link" }));
    res.redirect(hcaAuthorizeUrl(hca, hcaRedirect, signer.sign({ purpose: "link-hca" }, STATE_TTL_MS)));
  });

  /** The Slack half on its own, for anyone who cannot or will not use Hack Club Auth. */
  router.get("/link/slack", (_req: Request, res: Response) => {
    res.redirect(slackAuthorizeUrl(linkRedirect, { purpose: "link" }));
  });

  /**
   * Come back from Hack Club Auth and carry the verified email into the Slack half. Nothing is
   * written here: there is no Slack user token yet, and the person could still abandon the flow.
   */
  router.get("/link/hca/callback", async (req: Request, res: Response) => {
    if (!hca) return void res.status(404).send(page("Not available", "<p>This bridge has no Hack Club Auth app configured.</p>"));
    const state = signer.verify<{ purpose: string; slackUserId?: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "link-hca") {
      res.status(400).send(page("Sign-in failed", "<p>That took too long, or the link was not one of ours. <a href='/link'>Start again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Sign-in cancelled", `<p>Hack Club Auth said: <code>${esc(req.query.error)}</code>.</p><p><a href='/link'>Start again</a>, or <a href='/link/slack'>continue with Slack only</a>.</p>`));
      return;
    }
    try {
      const profile = await hcaProfile(hca, String(req.query.code ?? ""), hcaRedirect);
      const email = profile.emailVerified === false ? undefined : profile.email;
      // Retry from a result page: they are already linked, so match and finish here.
      if (state.slackUserId) return void (await finishRetry(res, state.slackUserId, profile.slackId, email));
      if (!email) log.warn("hack club auth gave no verified email", { sub: profile.sub });
      res.redirect(slackAuthorizeUrl(linkRedirect, { purpose: "link", hcaEmail: email, hcaSlackId: profile.slackId }));
    } catch (err) {
      log.error("hca callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Sign-in failed", "<p>Something went wrong signing you in. <a href='/link'>Start again</a>, or <a href='/link/slack'>continue with Slack only</a>.</p>"));
    }
  });

  router.get("/link/callback", async (req: Request, res: Response) => {
    const state = signer.verify<{ purpose: string; hcaEmail?: string; hcaSlackId?: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "link") {
      res.status(400).send(page("Link failed", "<p>That took too long, or the link was not one of ours. <a href='/link'>Start again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Link cancelled", `<p>Slack said: <code>${esc(req.query.error)}</code>. <a href='/link'>Try again</a>.</p>`));
      return;
    }
    try {
      const { userId, userToken } = await exchangeCode(String(req.query.code ?? ""), linkRedirect);
      // Hack Club Auth knows which Slack account it belongs to. A different one means the two
      // halves are two different people, and matching them would hand over someone else's identity.
      if (state.hcaSlackId && state.hcaSlackId !== userId) {
        log.warn("hca sign-in is for a different slack account", { slack: userId, hca: state.hcaSlackId });
        res.status(403).send(page("Different account", "<p>That Hack Club account belongs to a different Slack user. <a href='/link'>Start again</a> with the two that go together.</p>"));
        return;
      }
      const profile = await getSlackProfile(ctx.hub, userId);
      const { match } = await linkAgent(userId, { userToken, hcaEmail: state.hcaEmail, slackEmail: profile.email });
      res.send(page(match ? "You're all set" : "Not set up yet", match ? ALL_SET : NOT_SET_UP + hcaOffer(userId, Boolean(state.hcaEmail))));
    } catch (err) {
      log.error("link callback failed", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send(page("Link failed", "<p>Something went wrong talking to Slack. <a href='/link'>Try again</a>.</p>"));
    }
  });

  /**
   * Offered when a link finished without a match and Hack Club Auth was never asked — the address
   * on their Slack profile is usually not the one they sign in with.
   */
  function hcaOffer(slackUserId: string, alreadyAsked: boolean): string {
    if (!hca || alreadyAsked) return "";
    const token = encodeURIComponent(signer.sign({ purpose: "link-hca-retry", slackUserId }, STATE_TTL_MS));
    return `<p>Do you sign in with a Hack Club account? <a href="/link/hca?t=${token}">Sign in with Hack Club Auth</a> and this may sort itself out.</p>`;
  }

  router.get("/link/hca", (req: Request, res: Response) => {
    if (!hca) {
      res.status(404).send(page("Not available", "<p>This bridge has no Hack Club Auth app configured.</p>"));
      return;
    }
    const carried = signer.verify<{ purpose: string; slackUserId: string }>(String(req.query.t ?? ""));
    if (!carried || carried.purpose !== "link-hca-retry") {
      res.status(400).send(page("Link failed", "<p>That link has expired. <a href='/link'>Start again</a>.</p>"));
      return;
    }
    res.redirect(hcaAuthorizeUrl(hca, hcaRedirect, signer.sign({ purpose: "link-hca", slackUserId: carried.slackUserId }, STATE_TTL_MS)));
  });

  /** The retry half of the Hack Club callback: they are linked already, so match and report. */
  async function finishRetry(res: Response, slackUserId: string, hcaSlackId: string | undefined, email: string | undefined): Promise<void> {
    if (hcaSlackId && hcaSlackId !== slackUserId) {
      log.warn("hca sign-in is for a different slack account", { slack: slackUserId, hca: hcaSlackId });
      res.status(403).send(page("Different account", "<p>That Hack Club account belongs to a different Slack user. <a href='/link'>Start again</a> with the two that go together.</p>"));
      return;
    }
    if (!email) {
      res.status(400).send(page("No verified email", `<p>Hack Club Auth gave us no verified email for that account, so there is nothing to go on.</p>${DONE}`));
      return;
    }
    const { match } = await linkAgent(slackUserId, { hcaEmail: email });
    log.info("finished a link from hack club auth", { slackUserId, matched: Boolean(match) });
    res.send(page(match ? "You're all set" : "Not set up yet", match ? ALL_SET : NOT_SET_UP));
  }

  // ---- Admin sign-in: same OAuth v2 flow as /link (Slack forbids mixing OpenID scopes with
  // other user scopes in one app install). Signing in also links the admin's account. ----

  router.get("/admin/login", (_req: Request, res: Response) => {
    res.redirect(slackAuthorizeUrl(adminRedirect, { purpose: "admin" }));
  });

  router.get("/admin/callback", async (req: Request, res: Response) => {
    const state = signer.verify<{ purpose: string }>(String(req.query.state ?? ""));
    if (!state || state.purpose !== "admin") {
      res.status(400).send(page("Sign-in failed", "<p>Invalid or expired state. <a href='/admin/login'>Try again</a>.</p>"));
      return;
    }
    if (req.query.error) {
      res.status(400).send(page("Sign-in cancelled", `<p>Slack said: <code>${esc(req.query.error)}</code>. <a href='/admin/login'>Try again</a>.</p>`));
      return;
    }
    try {
      const { userId, userToken } = await exchangeCode(String(req.query.code ?? ""), adminRedirect);
      // The roster is the gate: env-seeded superadmins plus everyone they and the bridge
      // admins have since invited. Being in ADMIN_SLACK_USER_IDS only seeds a row at boot.
      const actor = await loadActor(ctx.db, userId);
      if (!actor) {
        log.warn("admin sign-in denied", { userId });
        res
          .status(403)
          .send(
            page(
              "Not allowed",
              `<p>Slack user <code>${esc(userId)}</code> has not been given access to this control panel.</p><p>Ask whoever runs your program to invite you, or a superadmin to add you.</p>`,
            ),
          );
        return;
      }
      const profile = await getSlackProfile(ctx.hub, userId);
      await linkAgent(userId, { userToken, slackEmail: profile.email }); // panel users are usually agents too; no harm otherwise
      await ctx.db.update(adminUsers).set({ name: profile.name, lastSeenAt: new Date() }).where(eq(adminUsers.slackUserId, userId));
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
