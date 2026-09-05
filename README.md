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

## Who can change what

The panel has three roles, so a distributed team can run its own programs without everyone being able to reconfigure everyone else's.

| | Superadmin | Admin | Operator |
|---|---|---|---|
| Sees | the whole install | the bridges they are on | the bridges they are on |
| Create a bridge | yes | yes — and owns what they create | no |
| Configure a bridge they are on | yes | yes | yes, including its tokens |
| Invite people to it / delete it | yes | yes, on their own bridges | no |
| Manage the roster (who may sign in) | yes | no | no |
| Threads, agents, retries | everything | filtered to their bridges | filtered to their bridges |

The flow this is built for: a superadmin makes a program author an **admin**; the author stands up their own bridge and becomes its admin; they invite their support team as **operators** on that bridge alone. Nobody needs a superadmin after the first step, and an operator on one program cannot see or touch another.

`ADMIN_SLACK_USER_IDS` is only a bootstrap. It is read while no superadmin exists yet — on a fresh install, or if the database is ever reset — and ignored after that, so demoting someone in the panel is not undone by the next restart. Everyone else joins by being invited: they sign in at `${PUBLIC_URL}/admin/` with Slack and their roster entry lets them through. The panel refuses to remove the last superadmin or the last admin of a bridge.

## Agents linking their accounts

Every agent should visit `${PUBLIC_URL}/link` once (admins get linked automatically when they sign in to the panel). It is two sign-ins, in this order:

1. **Hack Club Auth**, if this deployment has an app for it. This is what Chatwoot itself signs people in with, so the email it returns is the one Chatwoot knows them by. It is verified, and it comes back with the Slack account it belongs to.
2. **Slack** (user scopes `chat:write`, `files:write`). The user token is stored encrypted; replies made in Chatwoot are then posted to Slack **from the agent's own Slack account** via `chat.postMessage`.

The Hack Club address is what the Chatwoot agent lookup runs against, with the Slack profile address as the fallback — and it is stored either way, even when it matches nobody, because it is still the address Chatwoot would have to invite. Matching on the Slack address instead is what creates duplicate Chatwoot accounts for people. If Hack Club Auth names a *different* Slack account than the one that then signs in, the link is refused, so nobody can claim someone else's Chatwoot identity.

Set `HCA_CLIENT_ID` and `HCA_CLIENT_SECRET` (and `HCA_ISSUER` if you are not on <https://auth.hackclub.com>) to turn the first step on, registering `${PUBLIC_URL}/link/hca/callback` as the app's redirect URI at [Hack Club Auth](https://auth.hackclub.com/docs/welcome); the bridge asks for `openid profile email slack_id` (`email` and `slack_id` are scopes there, not claims that come with `profile`, and the discovery document does not list them — ask for `openid profile` alone and userinfo comes back with no address in it). Leave the two unset and `/link` is the Slack step alone. Anyone who cannot get through Hack Club Auth can go straight to `${PUBLIC_URL}/link/slack`, and a link that finished without a match offers the Hack Club step as a second chance.

The pages people see at the end of this say whether they are set up and nothing else. They do not mention Chatwoot tokens, the control panel or the service agent: the person reading has no way to act on any of it, and most of them will never have a reason to know it exists. What is left to do shows up on the helper roster instead, where somebody can actually do it.

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

Chatwoot Cloud has no super admin console, so there it stays manual: anyone who runs the bridge attaches the agent's access token on the panel's *Agents* page.

## Giving helpers Chatwoot accounts

A bridge can watch a second Slack channel — the one the people who *answer* tickets are in — and turn its membership into agents on that bridge's Chatwoot account. Set it under *Edit* → **Helpers**, then manage it from the **Helpers** button on the bridge.

Setting the channel provisions nobody. It only starts tracking who is in it. Everything else is deliberate, because the failure mode here is loud and hard to undo: one `/invite` of a big user group must not become fifty Chatwoot invitation emails.

**Reviewing.** *Review the channel* reads Slack and Chatwoot and sorts everyone into what provisioning them would actually do:

| | what happens | ticked by default |
|---|---|---|
| already agents | nothing in Chatwoot; the bridge just records that it knows them | – (nothing to do) |
| Chatwoot knows them | added to this account — no new login, no email | yes |
| would be a new account | a Chatwoot user is created and emailed an invitation | **no** |
| cannot be provisioned | a bot, or no email to key a user on | never |

Reviewing is a read: it provisions and unlinks nobody. The button that does the work names the count — *Provision 7 people* — and says how many of those are new accounts. Provisioning sends the exact list of people the reviewer saw, and the server refuses it if the count does not match what they approved.

**Where the email comes from.** Chatwoot keys users on email, so provisioning needs one. The bridge takes it from the `agents` row written at `/link` if there is one, and otherwise from the Slack profile (`users:read.email`; without that scope everyone lands in *cannot be provisioned*).

Having linked is not itself evidence, though. What counts is where the address came from, which `/link` records on the row (`agents.email_source`), and the review screen labels each address by it:

- **confirmed** — matched to a Chatwoot user. These are the *already an agent* and *Chatwoot knows them* buckets.
- **verified by Hack Club Auth** — the address they sign in with. Not proof Chatwoot has them, but it is the right address to invite.
- **set by hand in this panel** — an admin picked their Chatwoot user for them.
- **their Slack profile address** — nothing has confirmed Chatwoot knows it.

Only the first is trusted for provisioning. That last case is the trap: a Hack Club account's Chatwoot address is often not the one on their Slack profile, so inviting the Slack address hands them a *second* Chatwoot login instead of the account they already use.

**So the bridge asks rather than guesses.** Anyone it cannot identify gets one direct message from the bridge bot pointing them at `/link` — at most once a week per person, never to a bot, and never to somebody a human has skipped. The moment they link and Chatwoot recognises them, they are provisioned automatically, with no further clicks by anyone. That holds even on a bridge set to provision nobody automatically: having been sent the message *is* the decision, and it still never invites anyone Chatwoot has not already got a user for. That is the whole loop:

```
joins #helpers ──▶ can we identify them?
                     yes ──▶ provisioned
                     no  ──▶ DM: "link your account" ──▶ they link ──▶ provisioned
```

The message text is a per-bridge setting (`{link}` and `{channel}` are substituted); blank never asks. It goes out on a join under the `existing` and `all` policies, and the review screen has an **Ask N to link** button for doing it to people already in the channel. Asking creates nothing in Chatwoot, and the same batch limit and burst guard cover it, so a mass invite cannot become a mass DM either. Needs `im:write` on the bridge's Slack app.

**Joining and leaving.** With the bot in that channel and its Slack app subscribed to `member_joined_channel` and `member_left_channel`, every join and departure is recorded. What the bridge does with a join is a per-bridge setting:

- **record it, wait for a human** (the default) — nothing is provisioned.
- **if Chatwoot already has their user** — they are added to the account; anyone Chatwoot has never seen waits for review.
- **including new users** — an address is guessed from their Slack profile and an invitation goes out. Only right on an install where Slack emails *are* the Chatwoot emails.

More joins than the bridge's batch limit within ten minutes stops automatic provisioning altogether and asks for a human. Nobody is dropped by that: they sit in the roster as `pending` until somebody clears the pause and reviews them.

**Nothing is ever deleted.** Leaving the channel at most takes someone off that Chatwoot *account* — their Chatwoot user, its login and everything they wrote stay exactly where they are, and coming back later finds the same user rather than making a second one. There is no code path in this project that deletes a Chatwoot account; the client class does not even have a method for it. Set offboarding to *just record it* and even the account membership is left alone. Roster rows are kept forever too, so the panel can always answer who was provisioned, by whom, and when.

Requirements: the bridge's Chatwoot service token must belong to an **administrator** of the account (the review screen says so plainly if it does not), and its Slack app needs `im:write` to send the link requests, plus `groups:read` if the helper channel is private. Only a bridge's *admins* may provision, unlink, or change any of these settings — its operators can look.

## How it behaves

- Slack events are acknowledged immediately; all Chatwoot/Slack calls happen afterwards. Duplicate deliveries are dropped via `event_id` (24h TTL).
- Every relayed message is recorded (`relayed` table) so nothing echoes back. Messages the bridge posts to Slack also carry a metadata marker.
- Any failed outbound call is queued in Postgres and retried with exponential backoff (30s → 1h, 8 attempts), including honoring Slack `Retry-After`. Posts are throttled to ~1/sec/channel.
- Attachments go both ways as real files (≤ 40 MB): Slack files are downloaded with the bridge bot and attached to the Chatwoot message; Chatwoot attachments are uploaded into the Slack thread with `files.uploadV2`, as the agent when their linked token has `files:write`, else by the bot with the agent named. If a download or upload fails the file is posted as a link instead.
- Chatwoot flags a message as failed when the inbox webhook cannot be reached, so a red message in Chatwoot means the bridge is down or the URL's secret is wrong. Rejected webhooks are logged with a warning.
- The welcome message and the resolved/reopened notices carry a button that the asker or any linked agent can click: **Resolve** while the conversation is open, **Reopen** once it is resolved. It is re-labelled whenever Chatwoot reports a status change, both labels are configurable, and either can be blanked to hide the button in that state. Anyone else who clicks gets a private in-thread note explaining why not. The button needs Interactivity enabled on the bridge's Slack app, at the same request URL as its events.
- The bridge bot posts a welcome message in each new thread, a "resolved" notice when the conversation is resolved (from Slack or Chatwoot), and swaps it for a "reopened" notice if the conversation reopens. All three texts are per-bridge settings; blank disables.
- If the question is deleted in Slack, bridging for that thread stops: no welcome message, no further relaying either way, and the Chatwoot agents get a private note saying so. Slack leaves a tombstone parent behind, so if only the bridge's own messages are still under it they are removed as well; anything a person wrote is left alone. Slack does not reject a reply whose parent is gone, it posts it to the channel instead, so every threaded post is checked and any stray channel message is removed.
- Deleting a single message is carried across both ways. When someone deletes a relayed reply in Slack, the Chatwoot message is not removed — helpers need to know both what was said and that it is gone — so it is rewritten as `[DELETED]` followed by the original text, struck through. When an agent deletes a message in Chatwoot it is removed from the Slack thread, using that agent's own token if the bot is not allowed to delete their message. Each side acts only on messages it originally sent, so the two never chase each other.
- A reply sent with Slack's "Also send to #channel" box ticked is relayed as usual, and its sender gets a private note asking them to delete the copy Slack left in the channel.
- Someone who posts a second question in the channel within five minutes of their last one is asked, privately, whether it really is separate. Nothing reaches Chatwoot and no welcome message goes out until they answer: separate opens a ticket as usual, a follow-up opens none and they are asked to move it into their earlier thread. Ten minutes of silence lets it through as a separate question. Per bridge; blank disables.
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

Layout: `src/bridges.ts` (bridge registry: one Bolt app + `ExpressReceiver` per bridge, mounted at `/slack/events/{slug}`), `src/slack/events.ts` (message + reaction handlers), `src/slack/post.ts` (posting with identity resolution), `src/slack/oauth.ts` (`/link` and admin sign-in via the hub app), `src/slack/manifest.ts` (per-bridge Slack manifest), `src/chatwoot/client.ts` (typed wrapper over the public + application APIs), `src/chatwoot/webhook.ts`, `src/admin/api.ts` and `src/admin/access.ts` (roles and scoping), `src/dashboard.ts` + `public/slack-emoji.js` (the Chatwoot dashboard script), `src/retry.ts`, `web/` (control panel).

## License

MIT
