# chatwoot-slack-inbox

Turns a Slack help channel into a [Chatwoot](https://www.chatwoot.com) inbox. Every top-level message in the channel becomes a Chatwoot conversation; thread replies flow both ways. Each event/team gets its own bridge — its own Slack bot, channel, and Chatwoot account/inbox — all managed from a small control panel.

Chatwoot's official Slack integration goes the other way (it mirrors Chatwoot conversations *into* Slack). This fills the gap.

> Unofficial. Not affiliated with Chatwoot or Slack.

```
 Slack #help channel                          Chatwoot API inbox
 ───────────────────                          ──────────────────
 top-level message      ──create contact──▶   new conversation
   └ thread reply (user) ───────────────▶     incoming message
   └ thread reply (linked agent) ───────▶     outgoing message, attributed to the agent
   └ ✅ on the parent   ────────────────▶     resolve   (agent or original author only)
   └ ✅ stamped by the bot ◀───────────────    conversation resolved (removed on reopen)
   └ 👀 on the parent   ────────────────▶     assign to reacting agent
   └ thread reply       ◀───── webhook ────   agent reply, posted from the agent's own
                                              Slack account (agents link once at /link)
```

## Setup

Requirements: a public HTTPS URL for this service, Node 22+ and Postgres (or Docker).

There are two kinds of Slack app: one **hub** app (sign-in, agent linking, user lookups — never posts) and one **bridge** app per event/team (the bot people see in the channel).

1. **Run it once with placeholder Slack credentials** so it can hand you a pre-filled manifest:
   ```bash
   cp .env.example .env   # CHATWOOT_BASE_URL, PUBLIC_URL, ADMIN_SLACK_USER_IDS, DATABASE_URL, secrets; leave SLACK_* as the placeholders
   npm install && npm run build && npm start
   ```
   Or with Docker: `docker compose up -d --build` (runs Postgres too). Migrations run on boot. `GET /healthz` returns `{"ok":true}`.
2. **Create the hub Slack app.** Open `${PUBLIC_URL}/setup` (no sign-in) and download the hub manifest, pre-filled with your redirect URLs — or use [`slack-manifest-hub.yml`](slack-manifest-hub.yml) and replace `bridge.example.com`. At <https://api.slack.com/apps> choose *Create New App → From a manifest*, install it, then put its bot token, client ID and client secret into `.env` and restart.
3. **Create a Chatwoot API inbox** for the event/team: *Settings → Inboxes → Add inbox → API*.
4. **Open the control panel** at `${PUBLIC_URL}/admin/`, sign in with Slack, click *New bridge*. The form walks through it: name → copy the generated manifest and create that team's Slack app from it → paste its bot token + signing secret → pick the channel (invite the bot first) → paste a Chatwoot *service agent* access token (Profile settings → Access token), pick the account and API inbox → choose or disable the ✅/👀 reactions.
5. **Point the Chatwoot inbox at the bridge**: *Settings → Inboxes → your API inbox → Configuration*, paste the webhook URL shown on the panel's Overview page (`${PUBLIC_URL}/webhooks/chatwoot/<secret>`) into **Webhook URL**. An API inbox's webhook receives every event with no subscriptions to tick, which is what the bridge wants.

   The alternative is an account-level webhook (*Settings → Integrations → Webhooks*) with the same URL; if you use that one you must subscribe it to both `message_created` and `conversation_status_changed`, or agent replies and resolve notices will silently never arrive.

Post in the channel; a conversation should appear in Chatwoot.

## Deploying on Dokploy

Option A — **Application** (Dockerfile) + Dokploy-managed Postgres. Recommended.

1. *Create Database → PostgreSQL*. Note the internal connection string (`postgres://user:pass@<db-name>:5432/<db>`).
2. *Create Application*, source = this Git repo, build type = **Dockerfile** (default `./Dockerfile`).
3. *Environment*: paste [`.env.example`](.env.example) filled in. `DATABASE_URL` = the internal string from step 1. `PUBLIC_URL` = the HTTPS domain you'll attach next. Leave `PORT` at 3000.
4. *Domains*: add your domain, container port **3000**, HTTPS on.
5. Deploy. The container runs migrations on boot and exposes `/healthz`, which the Dockerfile `HEALTHCHECK` uses. Then continue with the hub Slack app / control panel steps above, using that domain as `PUBLIC_URL`.

Option B — **Compose**: choose *Compose*, point it at [`docker-compose.dokploy.yml`](docker-compose.dokploy.yml) (it bundles Postgres, publishes no host ports, and joins `dokploy-network`), set the same variables plus `POSTGRES_PASSWORD` in *Environment*, and attach the domain to the `app` service on port 3000.

Redeploys are safe: migrations are idempotent, bridges/agents live in Postgres, and Slack retries any events missed during the restart.

## Agents linking their accounts

Every agent should visit `${PUBLIC_URL}/link` once (admins get linked automatically when they sign in to the panel). It runs a Slack OAuth flow (user scopes `chat:write`, `files:write`) and stores the user token encrypted; replies made in Chatwoot are then posted to Slack **from the agent's own Slack account** via `chat.postMessage`. Their Slack email is matched against the agents of every bridged Chatwoot account to find their Chatwoot user.

If an agent replies before linking, the message still reaches Slack (posted by the bridge's bot with the agent's name and avatar) and the agent gets a private note in the conversation pointing them to `/link`.

For the other direction — Slack replies attributed to them in Chatwoot — the bridge needs that agent's own Chatwoot access token. Without one their replies go out under the bridge's service agent (so they wear *its* name and avatar) with their name prefixed into the text.

Set `CHATWOOT_PLATFORM_TOKEN` and the bridge fetches each token itself, at `/link` and again on an agent's first reply if they linked before you configured it. Two one-off steps on a self-hosted Chatwoot:

1. `/super_admin` → *Platform Apps* → new app (any name); copy its access token into `CHATWOOT_PLATFORM_TOKEN`.
2. A platform app may only read users it created, so grant it the ones you already have, from `bundle exec rails c`:

   ```ruby
   app = PlatformApp.find_by(name: 'slack-bridge')
   User.find_each { |u| PlatformAppPermissible.find_or_create_by!(platform_app: app, permissible: u) }
   ```

   Re-run it after adding agents to Chatwoot, or the bridge falls back to the service agent for them.

Chatwoot Cloud has no super admin console, so there it stays manual: an admin attaches the agent's access token on the panel's *Agents* page.

## How it behaves

- Slack events are acknowledged immediately; all Chatwoot/Slack calls happen afterwards. Duplicate deliveries are dropped via `event_id` (24h TTL).
- Every relayed message is recorded (`relayed` table) so nothing echoes back. Messages the bridge posts to Slack also carry a metadata marker.
- Any failed outbound call is queued in Postgres and retried with exponential backoff (30s → 1h, 8 attempts), including honoring Slack `Retry-After`. Posts are throttled to ~1/sec/channel.
- Attachments go both ways as real files (≤ 40 MB): Slack files are downloaded with the bridge bot and attached to the Chatwoot message; Chatwoot attachments are uploaded into the Slack thread with `files.uploadV2`, as the agent when their linked token has `files:write`, else by the bot with the agent named. If a download or upload fails the file is posted as a link instead.
- Chatwoot flags a message as failed when the inbox webhook cannot be reached, so a red message in Chatwoot means the bridge is down or the URL's secret is wrong. Rejected webhooks are logged with a warning.
- The welcome message and the resolved/reopened notices carry a button that the asker or any linked agent can click: **Resolve** while the conversation is open, **Reopen** once it is resolved. It is re-labelled whenever Chatwoot reports a status change, both labels are configurable, and either can be blanked to hide the button in that state. Anyone else who clicks gets a private in-thread note explaining why not. The button needs Interactivity enabled on the bridge's Slack app, at the same request URL as its events.
- The bridge bot posts a welcome message in each new thread, a "resolved" notice when the conversation is resolved (from Slack or Chatwoot), and swaps it for a "reopened" notice if the conversation reopens. All three texts are per-bridge settings; blank disables.
- If the question is deleted in Slack, bridging for that thread stops: no welcome message, no further relaying either way, and the Chatwoot agents get a private note saying so. Slack leaves a tombstone parent behind, so if only the bridge's own messages are still under it they are removed as well; anything a person wrote is left alone. Slack does not reject a reply whose parent is gone, it posts it to the channel instead, so every threaded post is checked and any stray channel message is removed.
- A bridge can require a linked Slack account before it relays anything (off by default, per bridge). While it is on, no message from anyone who has not been through `/link` reaches Chatwoot — no thread, no contact, no anonymous route — and the sender gets a private in-thread notice pointing them at the link URL, or nothing at all if that text is blanked.
- Replies in threads that predate the bridge are ignored. Replies from someone other than the original poster are prefixed `**[Not OP] Name:**`.
- Chatwoot reopens resolved conversations itself when the contact writes again. When that happens the bridge asks the sender privately, in the thread, whether they meant to: a green button resolves it again, a red one keeps it open for a helper. Only they can see or answer it, and the text is a per-bridge setting.
- Contacts carry the Slack display name and avatar; both are refreshed on every new thread. Chatwoot also looks up Gravatar for contacts with an email, so on a self-hosted Chatwoot set `DISABLE_GRAVATAR=true` if you want Slack avatars to be the only source.
- Tokens (Slack user tokens, Chatwoot access tokens) are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`.

## Slack emoji in the Chatwoot dashboard

Chatwoot only knows Unicode emoji, so a workspace's custom ones (`:parrot:`, `:yay:`) don't exist for agents — but Slack expands the shortcode when the bridge relays the reply. A script loaded through Chatwoot's `DASHBOARD_SCRIPTS` makes all three emoji surfaces Slack's:

- **the emoji picker** — Chatwoot's grid is hidden and one list takes its place: the workspace's custom emoji on top, the standard set below
- **the `:` typeahead** — Chatwoot 4.x has its own; its list is replaced by the same combined one, Slack matches first, with the arrow keys, Enter and Tab claimed from it
- **message bubbles** — `:shortcode:` renders as the emoji instead of sitting there as text

A custom emoji goes in as the plain `:name:` (Slack expands it); a standard one goes in as the character, exactly as Chatwoot would have.

Set up (self-hosted Chatwoot; needs sysadmin access to the Chatwoot environment):

1. Reinstall the hub Slack app so it has the `emoji:read` scope — its manifest at `${PUBLIC_URL}/setup` now includes it. Existing installs must be reinstalled or the endpoints return a 503 saying so.
2. Add to Chatwoot's environment and restart:
   ```
   DASHBOARD_SCRIPTS=<script src="https://bridge.example.com/dashboard/slack-emoji.js"></script>
   ```
   Chatwoot injects that markup into the agent dashboard. Chatwoot Cloud has no such knob, so this is self-hosted only.

   The bridge serves the script itself, but it can equally come from a CDN — in that case name the bridge, or it won't know where to fetch emoji from:
   ```
   DASHBOARD_SCRIPTS=<script src="https://cdn.jsdelivr.net/gh/anscg/chatwoot-slack-inbox@<commit>/public/slack-emoji.js" data-bridge="https://bridge.example.com"></script>
   ```
   Pin a commit rather than a branch: jsDelivr caches a branch URL for hours, so a pinned SHA is both faster to purge and safer to reason about.

### How it holds up at 60k emoji

A big workspace (Hack Club's, for instance) has ~60,000 custom emoji: 6 MB of JSON, more than `localStorage` will even hold. So the browser never downloads the list — it asks the bridge:

| endpoint | answers with |
|---|---|
| `/dashboard/slack-emoji/search?q=&limit=` | ranked matches, ~2 KB — one debounced request per burst of typing |
| `/dashboard/slack-emoji/lookup?names=a,b,c` | just the names a rendered message mentions, pooled across every bubble on screen |
| `/dashboard/slack-emoji.json` | the whole list, gzipped with an ETag — nothing in the dashboard uses it; kept for export and debugging |

Server side there is one `emoji.list` call (that method isn't paginated — one request returns the workspace), held for 24 hours and refreshed behind whoever asks rather than in front of them. A search over 60k names takes about 5 ms. Everything the browser learns is memoised for the session, so scrolling back through a conversation costs nothing.

Standard emoji ship with the script as `public/unicode-emoji.json` — 1,847 of them, ~26 KB gzipped. It's Chatwoot's own set (MIT), so agents keep the exact glyphs and search terms they're used to; `node scripts/build-unicode-emoji.mjs <chatwoot-tag>` regenerates it. Slack's `emoji.list` is custom-only, which is why they can't come from there.

The endpoints are unauthenticated but `Access-Control-Allow-Origin` is limited to `CHATWOOT_BASE_URL` and `PUBLIC_URL`, and they expose nothing but emoji names and their already-public `slack-edge.com` image URLs.

### What it doesn't do

Shortcodes stay as text **while you type** them, and no script loaded through `DASHBOARD_SCRIPTS` can change that. Three routes exist and Chatwoot closes all three: ProseMirror decorations (the right mechanism, display-only) need the `EditorView`, which is reachable neither from the DOM nor from Chatwoot, which holds it in a module-private `let`; image nodes are in the schema but `buildEditor` always installs `isolateImagesPlugin`, which splits any paragraph so an image "ends up alone in its own paragraph — no text to its left or right"; and writing into the composer's DOM directly gets re-parsed by ProseMirror, which would eat the text. Inline rendering in the composer needs a patch to Chatwoot itself. Once sent, the message renders with images like any other bubble.

Because it hooks a UI it does not own, the script is written to fail quietly: every hook is guarded, surfaces it has handled are marked so the DOM observer stays cheap, and if decorating ever runs away it stops watching rather than pinning the tab. It was written against Chatwoot **4.17.1**; an upgrade that reworks the picker or the `:` popover can silently switch it off, and the endpoints keep working either way.

## Development

```bash
npm install
npm run dev        # server, with .env
npm run dev:web    # control panel with hot reload on :5173 (proxies API to :3000)
npm test           # vitest; uses in-process Postgres (PGlite), no network
npm run typecheck
npm run db:generate   # after editing src/db/schema.ts
```

Layout: `src/bridges.ts` (bridge registry: one Bolt app + `ExpressReceiver` per bridge, mounted at `/slack/events/{slug}`), `src/slack/events.ts` (message + reaction handlers), `src/slack/post.ts` (posting with identity resolution), `src/slack/oauth.ts` (`/link` and admin sign-in via the hub app), `src/slack/manifest.ts` (per-bridge Slack manifest), `src/chatwoot/client.ts` (typed wrapper over the public + application APIs), `src/chatwoot/webhook.ts`, `src/admin/api.ts`, `src/dashboard.ts` + `public/slack-emoji.js` (the Chatwoot dashboard script), `src/retry.ts`, `web/` (control panel).

## License

MIT
