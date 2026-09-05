import type { Config } from "./config.js";
import { log } from "./logger.js";

/**
 * Hack Club Auth: the OIDC provider people sign in to Chatwoot with. It is used here only to learn
 * which email someone really has on that side, because a Hack Club account's email is often not the
 * one on their Slack profile, and matching a Chatwoot agent by the Slack email then finds nobody.
 *
 * Endpoints are the ones at https://auth.hackclub.com/.well-known/openid-configuration; they are
 * fixed rather than discovered so a link attempt is one round trip fewer and cannot fail halfway.
 */
export interface HcaClient {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetchFn: typeof fetch;
}

export interface HcaProfile {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Hack Club Auth knows the account's Slack user, which is what ties this back to the linker. */
  slackId?: string;
}

/** The client, or undefined when this deployment has no Hack Club Auth app configured. */
export function hcaClient(config: Config, fetchFn: typeof fetch = fetch): HcaClient | undefined {
  if (!config.HCA_CLIENT_ID || !config.HCA_CLIENT_SECRET) return undefined;
  return { issuer: config.HCA_ISSUER, clientId: config.HCA_CLIENT_ID, clientSecret: config.HCA_CLIENT_SECRET, fetchFn };
}

/**
 * `email` and `slack_id` are scopes of their own here, not claims that come free with `profile` —
 * and the discovery document does not list them, so asking for `openid profile` alone gets a
 * userinfo response with no address in it at all. These four are the ones open to everybody.
 */
export const HCA_SCOPES = "openid profile email slack_id";

export function hcaAuthorizeUrl(hca: HcaClient, redirectUri: string, state: string): string {
  const url = new URL(`${hca.issuer}/oauth/authorize`);
  url.searchParams.set("client_id", hca.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", HCA_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the callback's code for an access token, then read the account's profile. */
export async function hcaProfile(hca: HcaClient, code: string, redirectUri: string): Promise<HcaProfile> {
  const tokenRes = await hca.fetchFn(`${hca.issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: hca.clientId,
      client_secret: hca.clientSecret,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`hca token exchange failed: HTTP ${tokenRes.status} ${tokenText.slice(0, 200)}`);
  const token = JSON.parse(tokenText) as { access_token?: string };
  if (!token.access_token) throw new Error("hca token response had no access_token");

  const infoRes = await hca.fetchFn(`${hca.issuer}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const infoText = await infoRes.text();
  if (!infoRes.ok) throw new Error(`hca userinfo failed: HTTP ${infoRes.status} ${infoText.slice(0, 200)}`);
  const info = JSON.parse(infoText) as Record<string, unknown>;
  const profile: HcaProfile = {
    sub: typeof info.sub === "string" ? info.sub : undefined,
    email: typeof info.email === "string" ? info.email : undefined,
    emailVerified: typeof info.email_verified === "boolean" ? info.email_verified : undefined,
    name: typeof info.name === "string" ? info.name : undefined,
    slackId: typeof info.slack_id === "string" ? info.slack_id : undefined,
  };
  // Hack Club Auth's own docs point at /api/v1/me rather than the OIDC userinfo endpoint, and the
  // two do not always carry the same fields. Fill the gaps from there rather than sending somebody
  // back empty-handed; a failure is not fatal, it just leaves us with what userinfo gave.
  if (!profile.email || !profile.slackId) {
    try {
      const me = await hca.fetchFn(`${hca.issuer}/api/v1/me`, {
        headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (me.ok) {
        const identity = ((await me.json()) as { identity?: Record<string, unknown> }).identity ?? {};
        if (!profile.email && typeof identity.primary_email === "string") profile.email = identity.primary_email;
        if (!profile.slackId && typeof identity.slack_id === "string") profile.slackId = identity.slack_id;
      } else {
        log.warn("hca /api/v1/me was unhelpful", { status: me.status });
      }
    } catch (err) {
      log.warn("could not read the hca identity", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.debug("hca profile", { sub: profile.sub, hasEmail: Boolean(profile.email), slackId: profile.slackId });
  return profile;
}
