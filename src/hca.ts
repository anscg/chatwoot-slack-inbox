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

export function hcaAuthorizeUrl(hca: HcaClient, redirectUri: string, state: string): string {
  const url = new URL(`${hca.issuer}/oauth/authorize`);
  url.searchParams.set("client_id", hca.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
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
  log.debug("hca profile", { sub: profile.sub, hasEmail: Boolean(profile.email), slackId: profile.slackId });
  return profile;
}
