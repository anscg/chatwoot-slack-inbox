/** Slack app manifest for one bridge's bot. Admin creates the app from this in the panel. */
export function bridgeManifest(opts: { name: string; slug: string; publicUrl: string }): string {
  const display = opts.name.slice(0, 35);
  return `display_information:
  name: ${yaml(display)}
  description: ${yaml(`Support for ${opts.name}.`)}
  background_color: "#1f93ff"
features:
  bot_user:
    display_name: ${yaml(display)}
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - channels:history
      - channels:read
      - reactions:read
      - reactions:write
      - files:read
      - files:write
      - users:read
      - users:read.email
settings:
  interactivity:
    is_enabled: true
    request_url: ${opts.publicUrl}/slack/events/${opts.slug}
  event_subscriptions:
    request_url: ${opts.publicUrl}/slack/events/${opts.slug}
    bot_events:
      - message.channels
      - reaction_added
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}

function yaml(s: string): string {
  return JSON.stringify(s);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Manifest for the single hub app: admin sign-in, /link, user lookups. Contains no secrets. */
export function hubManifest(opts: { publicUrl: string; name?: string }): string {
  const name = (opts.name ?? "Chatwoot Inbox Bridge").slice(0, 35);
  return `# Hub app for chatwoot-slack-inbox: admin sign-in, agent linking, user lookups.
# Each bridged channel gets its own Slack app; the control panel generates those.
display_information:
  name: ${yaml(name)}
  description: ${yaml("Sign-in and account linking for the Chatwoot Slack inbox bridge. Unofficial.")}
  background_color: "#1f93ff"
features:
  bot_user:
    display_name: ${yaml(name)}
    always_online: false
oauth_config:
  redirect_urls:
    - ${opts.publicUrl}/link/callback
    - ${opts.publicUrl}/admin/callback
  scopes:
    user:
      - chat:write
      - files:write
    bot:
      - users:read
      - users:read.email
      - emoji:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;
}
