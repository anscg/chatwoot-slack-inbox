import { WebClient } from "@slack/web-api";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { defaultAuthTest } from "../bridges.js";
import {
  type Actor,
  type BridgeRole,
  canAdministerBridge,
  canConfigureBridge,
  canCreateBridge,
  bridgeRole,
  isSuper,
  loadActor,
  rosterNames,
  visibleBridgeIds,
} from "./access.js";
import { ChatwootClient, ChatwootHttpError } from "../chatwoot/client.js";
import type { AppContext } from "../context.js";
import type { Db } from "../db/client.js";
import { recentTraffic } from "../diagnostics.js";
import { encryptToken } from "../crypto.js";
import { adminUsers, agents, bridgeMembers, bridges, relayed, retries, threads } from "../db/schema.js";
import {
  askHelpersToLink,
  listHelperEvents,
  listHelperMembers,
  provisionHelpers,
  resumeHelperAutoProvision,
  reviewHelpers,
  skipHelper,
  unlinkHelper,
  unskipHelper,
} from "../helpers.js";
import { log } from "../logger.js";
import { DEFAULT_FOLLOWUP_PROMPT, DEFAULT_HELPER_LINK_PROMPT, DEFAULT_LINK_PROMPT, DEFAULT_REOPEN_BUTTON_LABEL, DEFAULT_REOPEN_MESSAGE, DEFAULT_REOPEN_PROMPT, DEFAULT_RESOLVE_BUTTON_LABEL, DEFAULT_RESOLVE_MESSAGE, DEFAULT_RESOLVED_EMOJI, DEFAULT_WELCOME_MESSAGE } from "../messages.js";
import { ADMIN_COOKIE, parseCookies, Signer, type AdminSession } from "../session.js";
import { bridgeManifest, SLUG_RE, slugify } from "../slack/manifest.js";

/** Bot scopes a bridge app needs. Slack reports what was actually granted in the x-oauth-scopes header. */
export const REQUIRED_BOT_SCOPES = [
  "chat:write",
  "chat:write.customize",
  "channels:history",
  "channels:read",
  "reactions:read",
  "reactions:write",
  "files:read",
  "files:write",
  "users:read",
  "users:read.email",
];

/** Extra scopes a bridge only needs once it watches a helper channel; private channels need these. */
export const HELPER_BOT_SCOPES = ["groups:read", "im:write"];

const reactionField = z
  .string()
  .trim()
  .transform((s) => s.replace(/^:|:$/g, ""))
  .refine((s) => s === "" || /^[a-z0-9_+'-]+$/i.test(s), "emoji short name only, e.g. white_check_mark")
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional();

/** Bot message text; blank disables (stored as null). */
const messageField = z
  .string()
  .max(2000)
  .transform((s) => (s.trim() === "" ? null : s.trim()))
  .nullable()
  .optional();

/** Slack button labels max out at 75 characters; blank hides the button. */
const buttonLabelField = z
  .string()
  .max(75)
  .transform((v) => (v.trim() === "" ? null : v.trim()))
  .nullable()
  .optional();

const bridgeInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().regex(SLUG_RE, "lowercase letters, digits and dashes, max 40 chars"),
  slackChannel: z.string().trim().regex(/^[CG][A-Z0-9]+$/, "Slack channel ID like C0123456789"),
  /** Required on create; optional on update (keeps the existing values). */
  slackBotToken: z.string().trim().regex(/^xoxb-/, "must be a bot token (xoxb-...)").optional(),
  slackSigningSecret: z.string().trim().min(8).optional(),
  chatwootAccountId: z.coerce.number().int().positive(),
  chatwootInboxIdentifier: z.string().trim().min(1),
  chatwootApiToken: z.string().trim().min(1).optional(),
  reactionResolve: reactionField,
  reactionAssign: reactionField,
  resolvedEmoji: reactionField,
  welcomeMessage: messageField,
  resolveButtonLabel: buttonLabelField,
  reopenButtonLabel: buttonLabelField,
  resolveMessage: messageField,
  reopenMessage: messageField,
  reopenPromptMessage: messageField,
  followupPromptMessage: messageField,
  requireLink: z.boolean().optional(),
  linkPromptMessage: messageField,
  /** Blank unlinks the helper channel; the roster and its history are kept either way. */
  helperChannel: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || /^[CG][A-Z0-9]+$/.test(v), "Slack channel ID like C0123456789")
    .nullable()
    .optional(),
  helperAutoProvision: z.enum(["off", "existing", "all"]).optional(),
  helperLinkPrompt: messageField,
  helperOffboarding: z.enum(["keep", "unlink"]).optional(),
  helperMaxBatch: z.coerce.number().int().min(1).max(200).optional(),
  helperChatwootRole: z.enum(["agent", "administrator"]).optional(),
  enabled: z.boolean().optional(),
});

/** The fields that decide who gets a Chatwoot account; a bridge's operators may not touch them. */
const HELPER_SETTINGS = ["helperChannel", "helperAutoProvision", "helperOffboarding", "helperMaxBatch", "helperChatwootRole", "helperLinkPrompt"] as const;

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const badRequest = (res: Response, error: string) => void res.status(400).json({ error });
const zodMsg = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export type AuthedRequest = Request & { admin: AdminSession; actor: Actor };
const actorOf = (req: Request): Actor => (req as AuthedRequest).actor;

/**
 * Verify the session cookie, then resolve the person's current roles from the database.
 * Roles are read per request rather than baked into the cookie so that removing someone
 * takes effect at once instead of whenever their 12-hour session happens to expire.
 */
export function requireAdmin(signer: Signer, db: Db) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = signer.verify<AdminSession>(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
    if (!session) {
      res.status(401).json({ error: "not signed in" });
      return;
    }
    // CSRF: browsers won't add this header on cross-site form posts; SameSite=Lax covers the rest.
    if (req.method !== "GET" && req.headers["x-requested-with"] !== "fetch") {
      res.status(403).json({ error: "missing X-Requested-With header" });
      return;
    }
    (req as AuthedRequest).admin = session;
    loadActor(db, session.userId)
      .then((actor) => {
        if (!actor) {
          // Access was revoked while they held a valid cookie.
          res.status(403).json({ error: "your access to this control panel has been removed" });
          return;
        }
        (req as AuthedRequest).actor = actor;
        next();
      })
      .catch(next);
  };
}

/** 403 unless the person passes `allow`; returns whether the request may continue. */
function guard(req: Request, res: Response, allow: boolean, message = "you do not have access to that"): boolean {
  if (allow) return true;
  res.status(403).json({ error: message });
  return false;
}

export interface AdminApiOptions {
  /** Both overridable for tests, so verifying a pasted token hits no network. */
  createSlackClient?: (token: string) => WebClient;
  createChatwootClient?: (apiToken: string) => ChatwootClient;
}

export function registerAdminApi(router: Router, ctx: AppContext, opts: AdminApiOptions = {}): void {
  const { config, db } = ctx;
  const signer = new Signer(config.TOKEN_ENCRYPTION_KEY);
  const api = express.Router();
  api.use(express.json({ limit: "256kb" }));
  api.use(requireAdmin(signer, db));

  const slackClient = opts.createSlackClient ?? ((t: string) => new WebClient(t));
  const introspectClient =
    opts.createChatwootClient ?? ((apiToken: string) => new ChatwootClient({ baseUrl: config.CHATWOOT_BASE_URL, accountId: 0, inboxIdentifier: "", apiToken }));
  const enc = (v: string) => encryptToken(v, config.TOKEN_ENCRYPTION_KEY);

  api.get("/me", (req, res) => {
    const actor = actorOf(req);
    res.json({
      user: { userId: actor.slackUserId, name: actor.name, role: actor.role },
      can: { createBridge: canCreateBridge(actor), managePeople: isSuper(actor), seeOps: isSuper(actor) },
      chatwootBaseUrl: config.CHATWOOT_BASE_URL,
      publicUrl: config.PUBLIC_URL,
      defaults: {
        welcomeMessage: DEFAULT_WELCOME_MESSAGE,
        resolvedEmoji: DEFAULT_RESOLVED_EMOJI,
        resolveButtonLabel: DEFAULT_RESOLVE_BUTTON_LABEL,
        reopenButtonLabel: DEFAULT_REOPEN_BUTTON_LABEL,
        resolveMessage: DEFAULT_RESOLVE_MESSAGE,
        reopenMessage: DEFAULT_REOPEN_MESSAGE,
        reopenPromptMessage: DEFAULT_REOPEN_PROMPT,
        followupPromptMessage: DEFAULT_FOLLOWUP_PROMPT,
        linkPromptMessage: DEFAULT_LINK_PROMPT,
        helperLinkPrompt: DEFAULT_HELPER_LINK_PROMPT,
      },
    });
  });

  api.get(
    "/status",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      const scope = await scopeOf(actor);
      const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const [threadCount, relayedCount, agentCount, retryCount] = await Promise.all([
        count(db.select({ n: sql<number>`count(*)::int` }).from(threads).where(scope.channelFilter(threads.slackChannel))),
        count(db.select({ n: sql<number>`count(*)::int` }).from(relayed).where(scope.channelFilter(relayed.slackChannel))),
        scope.all ? count(db.select({ n: sql<number>`count(*)::int` }).from(agents)) : (await visibleAgents(actor)).length,
        scope.all ? count(db.select({ n: sql<number>`count(*)::int` }).from(retries)) : (await visibleRetries(actor)).length,
      ]);
      res.json({
        // The webhook URL embeds the install-wide Chatwoot secret, so only superadmins see it.
        ...(isSuper(actor) ? { webhookUrl: `${config.PUBLIC_URL}/webhooks/chatwoot/${config.CHATWOOT_WEBHOOK_SECRET}` } : {}),
        linkUrl: `${config.PUBLIC_URL}/link`,
        counts: { threads: threadCount, relayed: relayedCount, agents: agentCount, retries: retryCount },
      });
    }),
  );

  // ---- scoping ----

  /**
   * What this person can see, expressed as filters. A superadmin gets `all`, and every filter
   * is a no-op; anyone else is confined to the bridges they hold a membership on. Someone with
   * no bridges gets `sql\`false\``, i.e. empty lists rather than everything.
   */
  async function scopeOf(actor: Actor) {
    const ids = visibleBridgeIds(actor);
    if (ids === null) return { all: true as const, bridgeIds: null, rows: [], channels: [], accounts: [], channelFilter: () => undefined as SQL | undefined };
    const rows = ids.length ? await db.select().from(bridges).where(inArray(bridges.id, ids)) : [];
    const channels = rows.map((b) => b.slackChannel);
    const accounts = [...new Set(rows.map((b) => b.chatwootAccountId))];
    return {
      all: false as const,
      bridgeIds: ids,
      rows,
      channels,
      accounts,
      channelFilter: (col: PgColumn): SQL | undefined => (channels.length ? inArray(col, channels) : sql`false`),
    };
  }

  /** Load a bridge and check the viewer may act on it; replies 404/403 itself and returns undefined. */
  async function bridgeFor(req: Request, res: Response, need: "configure" | "administer") {
    const actor = actorOf(req);
    const id = Number(req.params.id);
    const row = (await db.select().from(bridges).where(eq(bridges.id, id)))[0];
    // 404 rather than 403 for a bridge they cannot see: no reason to confirm it exists.
    if (!row || !canConfigureBridge(actor, id)) {
      res.status(404).json({ error: "not found" });
      return undefined;
    }
    if (need === "administer" && !canAdministerBridge(actor, id)) {
      res.status(403).json({ error: "only an admin of this bridge can do that" });
      return undefined;
    }
    return row;
  }

  // ---- bridges ----

  const redact = (b: typeof bridges.$inferSelect, actor?: Actor) => {
    const { chatwootApiTokenEnc: _c, slackBotTokenEnc: _b, slackSigningSecretEnc: _s, ...rest } = b;
    return {
      ...rest,
      hasChatwootToken: Boolean(b.chatwootApiTokenEnc),
      hasSlackApp: Boolean(b.slackBotTokenEnc),
      eventsUrl: `${config.PUBLIC_URL}/slack/events/${b.slug}`,
      ...(actor ? { yourRole: bridgeRole(actor, b.id) ?? null } : {}),
    };
  };

  api.get(
    "/bridges",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      const ids = visibleBridgeIds(actor);
      if (ids !== null && ids.length === 0) return void res.json([]);
      const rows = await db
        .select()
        .from(bridges)
        .where(ids === null ? undefined : inArray(bridges.id, ids))
        .orderBy(bridges.name);
      res.json(rows.map((b) => redact(b, actor)));
    }),
  );

  /** Manifest for a bridge's Slack app, before or after the bridge exists. */
  api.get("/manifest", (req, res) => {
    const actor = actorOf(req);
    if (!guard(req, res, canCreateBridge(actor) || actor.bridges.size > 0)) return;
    const name = String(req.query.name ?? "").trim() || "Support Bridge";
    const slug = String(req.query.slug ?? "").trim() || slugify(name);
    if (!SLUG_RE.test(slug)) return badRequest(res, "invalid slug");
    res.type("text/yaml");
    if (req.query.download) res.attachment(`${slug}.slack-manifest.yml`);
    res.send(bridgeManifest({ name, slug, publicUrl: config.PUBLIC_URL }));
  });

  api.post(
    "/bridges",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      if (!guard(req, res, canCreateBridge(actor), "only an admin can create a bridge; ask a superadmin to promote you")) return;
      const input = bridgeInput.safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const d = input.data;
      if (!d.chatwootApiToken) return badRequest(res, "chatwootApiToken is required");
      if (!d.slackBotToken || !d.slackSigningSecret) return badRequest(res, "slackBotToken and slackSigningSecret are required");
      const cw = await verifyServiceToken(introspectClient(d.chatwootApiToken), d.chatwootAccountId, d.chatwootInboxIdentifier, d.chatwootApiToken);
      if (typeof cw === "string") return badRequest(res, cw);
      const bot = await verifyBotToken(slackClient(d.slackBotToken), d.slackChannel);
      if ("error" in bot) return badRequest(res, bot.error);
      const [row] = await db
        .insert(bridges)
        .values({
          name: d.name,
          slug: d.slug,
          slackChannel: d.slackChannel,
          slackBotTokenEnc: enc(d.slackBotToken),
          slackSigningSecretEnc: enc(d.slackSigningSecret),
          slackBotId: bot.botId,
          slackBotUserId: bot.botUserId,
          slackTeamId: bot.teamId,
          chatwootAccountId: d.chatwootAccountId,
          chatwootInboxIdentifier: d.chatwootInboxIdentifier,
          chatwootInboxId: cw.inboxId,
          chatwootApiTokenEnc: enc(d.chatwootApiToken),
          reactionResolve: d.reactionResolve === undefined ? "white_check_mark" : d.reactionResolve,
          reactionAssign: d.reactionAssign === undefined ? "eyes" : d.reactionAssign,
          resolvedEmoji: d.resolvedEmoji === undefined ? DEFAULT_RESOLVED_EMOJI : d.resolvedEmoji,
          welcomeMessage: d.welcomeMessage === undefined ? DEFAULT_WELCOME_MESSAGE : d.welcomeMessage,
          resolveButtonLabel: d.resolveButtonLabel === undefined ? DEFAULT_RESOLVE_BUTTON_LABEL : d.resolveButtonLabel,
          reopenButtonLabel: d.reopenButtonLabel === undefined ? DEFAULT_REOPEN_BUTTON_LABEL : d.reopenButtonLabel,
          resolveMessage: d.resolveMessage === undefined ? DEFAULT_RESOLVE_MESSAGE : d.resolveMessage,
          reopenMessage: d.reopenMessage === undefined ? DEFAULT_REOPEN_MESSAGE : d.reopenMessage,
          reopenPromptMessage: d.reopenPromptMessage === undefined ? DEFAULT_REOPEN_PROMPT : d.reopenPromptMessage,
          followupPromptMessage: d.followupPromptMessage === undefined ? DEFAULT_FOLLOWUP_PROMPT : d.followupPromptMessage,
          requireLink: d.requireLink ?? false,
          linkPromptMessage: d.linkPromptMessage === undefined ? DEFAULT_LINK_PROMPT : d.linkPromptMessage,
          // A helper channel starts inert: membership is tracked, nobody is provisioned until asked.
          helperChannel: d.helperChannel ?? null,
          helperAutoProvision: d.helperAutoProvision ?? "off",
          helperLinkPrompt: d.helperLinkPrompt === undefined ? DEFAULT_HELPER_LINK_PROMPT : d.helperLinkPrompt,
          helperOffboarding: d.helperOffboarding ?? "unlink",
          ...(d.helperMaxBatch !== undefined ? { helperMaxBatch: d.helperMaxBatch } : {}),
          helperChatwootRole: d.helperChatwootRole ?? "agent",
          enabled: d.enabled ?? true,
        })
        .returning();
      // Whoever creates a bridge owns it, so a program author never needs a superadmin again.
      await db.insert(bridgeMembers).values({ bridgeId: row!.id, slackUserId: actor.slackUserId, role: "admin" }).onConflictDoNothing();
      actor.bridges.set(row!.id, "admin");
      await ctx.bridges.reload();
      log.info("bridge created", { bridge: row!.name, by: actor.slackUserId });
      res.status(201).json({ ...redact(row!, actor), warning: bot.warning });
    }),
  );

  api.put(
    "/bridges/:id",
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const input = bridgeInput.partial().safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const existing = await bridgeFor(req, res, "configure");
      if (!existing) return;
      const d = input.data;
      // Who gets a Chatwoot account is an ownership decision, not a configuration one.
      const touchesHelpers = HELPER_SETTINGS.some((k) => d[k] !== undefined && d[k] !== existing[k]);
      if (touchesHelpers && !guard(req, res, canAdministerBridge(actorOf(req), id), "only an admin of this bridge can change who gets a Chatwoot account")) return;
      const accountId = d.chatwootAccountId ?? existing.chatwootAccountId;
      const inbox = d.chatwootInboxIdentifier ?? existing.chatwootInboxIdentifier;
      const channel = d.slackChannel ?? existing.slackChannel;
      let inboxId: number | undefined;
      if (d.chatwootApiToken) {
        const cw = await verifyServiceToken(introspectClient(d.chatwootApiToken), accountId, inbox, d.chatwootApiToken);
        if (typeof cw === "string") return badRequest(res, cw);
        inboxId = cw.inboxId;
      }
      let botIds: { botId: string; botUserId: string; teamId?: string; warning?: string } | undefined;
      let warning: string | undefined;
      if (d.slackBotToken) {
        const bot = await verifyBotToken(slackClient(d.slackBotToken), channel);
        if ("error" in bot) return badRequest(res, bot.error);
        botIds = bot;
        warning = bot.warning;
      }
      const [row] = await db
        .update(bridges)
        .set({
          ...(d.name !== undefined ? { name: d.name } : {}),
          ...(d.slug !== undefined ? { slug: d.slug } : {}),
          slackChannel: channel,
          ...(d.slackBotToken ? { slackBotTokenEnc: enc(d.slackBotToken), slackBotId: botIds!.botId, slackBotUserId: botIds!.botUserId, slackTeamId: botIds!.teamId } : {}),
          ...(d.slackSigningSecret ? { slackSigningSecretEnc: enc(d.slackSigningSecret) } : {}),
          chatwootAccountId: accountId,
          chatwootInboxIdentifier: inbox,
          ...(inboxId !== undefined ? { chatwootInboxId: inboxId } : inbox !== existing.chatwootInboxIdentifier ? { chatwootInboxId: null } : {}),
          ...(d.chatwootApiToken ? { chatwootApiTokenEnc: enc(d.chatwootApiToken) } : {}),
          ...(d.reactionResolve !== undefined ? { reactionResolve: d.reactionResolve } : {}),
          ...(d.reactionAssign !== undefined ? { reactionAssign: d.reactionAssign } : {}),
          ...(d.resolvedEmoji !== undefined ? { resolvedEmoji: d.resolvedEmoji } : {}),
          ...(d.welcomeMessage !== undefined ? { welcomeMessage: d.welcomeMessage } : {}),
          ...(d.resolveButtonLabel !== undefined ? { resolveButtonLabel: d.resolveButtonLabel } : {}),
          ...(d.reopenButtonLabel !== undefined ? { reopenButtonLabel: d.reopenButtonLabel } : {}),
          ...(d.resolveMessage !== undefined ? { resolveMessage: d.resolveMessage } : {}),
          ...(d.reopenMessage !== undefined ? { reopenMessage: d.reopenMessage } : {}),
          ...(d.reopenPromptMessage !== undefined ? { reopenPromptMessage: d.reopenPromptMessage } : {}),
          ...(d.followupPromptMessage !== undefined ? { followupPromptMessage: d.followupPromptMessage } : {}),
          ...(d.requireLink !== undefined ? { requireLink: d.requireLink } : {}),
          ...(d.linkPromptMessage !== undefined ? { linkPromptMessage: d.linkPromptMessage } : {}),
          ...(d.helperChannel !== undefined ? { helperChannel: d.helperChannel } : {}),
          ...(d.helperAutoProvision !== undefined ? { helperAutoProvision: d.helperAutoProvision } : {}),
          ...(d.helperLinkPrompt !== undefined ? { helperLinkPrompt: d.helperLinkPrompt } : {}),
          ...(d.helperOffboarding !== undefined ? { helperOffboarding: d.helperOffboarding } : {}),
          ...(d.helperMaxBatch !== undefined ? { helperMaxBatch: d.helperMaxBatch } : {}),
          ...(d.helperChatwootRole !== undefined ? { helperChatwootRole: d.helperChatwootRole } : {}),
          // Pointing the bridge at a different channel clears a pause that was about the old one.
          ...(d.helperChannel !== undefined && d.helperChannel !== existing.helperChannel ? { helperPausedAt: null, helperPausedReason: null } : {}),
          ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(bridges.id, id))
        .returning();
      await ctx.bridges.reload();
      res.json({ ...redact(row!, actorOf(req)), warning });
    }),
  );

  /**
   * Per-bridge self check: what Slack actually granted this app, whether the bot is in the channel,
   * whether Chatwoot answers, and which behaviours are switched on. Slack offers no API to read an
   * app's own event subscriptions, so those stay the one thing a human has to confirm.
   */
  api.get(
    "/bridges/:id/check",
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const row = await bridgeFor(req, res, "configure");
      if (!row) return;
      const bridge = ctx.bridges.get(id);
      const out: Record<string, unknown> = {
        name: row.name,
        enabled: row.enabled,
        loaded: Boolean(bridge),
        eventsUrl: `${config.PUBLIC_URL}/slack/events/${row.slug}`,
        behaviour: {
          reactionResolve: row.reactionResolve,
          reactionAssign: row.reactionAssign,
          resolvedEmoji: row.resolvedEmoji,
          resolveButtonLabel: row.resolveButtonLabel,
          reopenButtonLabel: row.reopenButtonLabel,
          welcomeMessage: Boolean(row.welcomeMessage),
          resolveMessage: Boolean(row.resolveMessage),
          reopenMessage: Boolean(row.reopenMessage),
          reopenPromptMessage: Boolean(row.reopenPromptMessage),
          followupPromptMessage: Boolean(row.followupPromptMessage),
          requireLink: row.requireLink,
          linkPromptMessage: Boolean(row.linkPromptMessage),
          helperChannel: row.helperChannel,
          helperAutoProvision: row.helperAutoProvision,
        },
      };
      const [{ n: threadCount } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(threads)
        .where(eq(threads.slackChannel, row.slackChannel));
      out.threads = threadCount;
      out.traffic = recentTraffic(id);

      if (bridge) {
        try {
          const auth = await bridge.slack.auth.test();
          const scopes = (auth.response_metadata as { scopes?: string[] } | undefined)?.scopes ?? [];
          const slack: Record<string, unknown> = {
            bot: auth.user_id,
            team: auth.team,
            scopes,
            // groups:read only matters once a helper channel is watched, so don't nag bridges without one.
            missingScopes: [...REQUIRED_BOT_SCOPES, ...(row.helperChannel ? HELPER_BOT_SCOPES : [])].filter((s) => !scopes.includes(s)),
          };
          try {
            const info = await bridge.slack.conversations.info({ channel: row.slackChannel });
            slack.channel = { id: row.slackChannel, name: info.channel?.name, isMember: Boolean(info.channel?.is_member) };
          } catch (err) {
            slack.channel = { id: row.slackChannel, error: err instanceof Error ? err.message : String(err) };
          }
          if (row.helperChannel) {
            try {
              const info = await bridge.slack.conversations.info({ channel: row.helperChannel });
              slack.helperChannel = { id: row.helperChannel, name: info.channel?.name, isMember: Boolean(info.channel?.is_member) };
            } catch (err) {
              slack.helperChannel = { id: row.helperChannel, error: err instanceof Error ? err.message : String(err) };
            }
          }
          out.slack = slack;
        } catch (err) {
          out.slack = { error: err instanceof Error ? err.message : String(err) };
        }
        try {
          const agents = await bridge.chatwoot.listAgents();
          out.chatwoot = { ok: true, accountId: row.chatwootAccountId, agents: agents.length };
        } catch (err) {
          out.chatwoot = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      res.json(out);
    }),
  );

  api.delete(
    "/bridges/:id",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      await db.delete(bridges).where(eq(bridges.id, row.id));
      await ctx.bridges.reload();
      log.info("bridge deleted", { bridge: row.name, by: actorOf(req).slackUserId });
      res.status(204).end();
    }),
  );

  // ---- who may touch a bridge ----

  const SLACK_USER_RE = /^[UW][A-Z0-9]+$/;

  /** Everyone on this bridge, plus the superadmins who reach it implicitly. */
  api.get(
    "/bridges/:id/members",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "configure");
      if (!row) return;
      const members = await db.select().from(bridgeMembers).where(eq(bridgeMembers.bridgeId, row.id)).orderBy(bridgeMembers.createdAt);
      const supers = await db.select().from(adminUsers).where(eq(adminUsers.role, "superadmin"));
      const names = await rosterNames(
        db,
        members.map((m) => m.slackUserId),
      );
      res.json({
        canInvite: canAdministerBridge(actorOf(req), row.id),
        members: members.map((m) => ({ slackUserId: m.slackUserId, name: names.get(m.slackUserId) ?? null, role: m.role, invitedBy: m.invitedBy, createdAt: m.createdAt })),
        superadmins: supers.map((u) => ({ slackUserId: u.slackUserId, name: u.name })),
      });
    }),
  );

  /**
   * Invite someone to one bridge. Creates their panel account as an `operator` if they have
   * none: a community member who can run this bridge and nothing else. An existing global
   * role is never lowered by an invite.
   */
  api.post(
    "/bridges/:id/members",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      const actor = actorOf(req);
      const input = z
        .object({ slackUserId: z.string().trim().regex(SLACK_USER_RE, "Slack user ID like U0123456789"), role: z.enum(["admin", "operator"]).default("operator") })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const { slackUserId, role } = input.data;
      await db
        .insert(adminUsers)
        .values({ slackUserId, role: "operator", invitedBy: actor.slackUserId })
        .onConflictDoNothing();
      const [member] = await db
        .insert(bridgeMembers)
        .values({ bridgeId: row.id, slackUserId, role, invitedBy: actor.slackUserId })
        .onConflictDoUpdate({ target: [bridgeMembers.bridgeId, bridgeMembers.slackUserId], set: { role } })
        .returning();
      log.info("bridge member added", { bridge: row.name, slackUserId, role, by: actor.slackUserId });
      res.status(201).json({ slackUserId, role: member!.role, invitedBy: member!.invitedBy, createdAt: member!.createdAt });
    }),
  );

  api.delete(
    "/bridges/:id/members/:slackUserId",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      const slackUserId = String(req.params.slackUserId);
      const members = await db.select().from(bridgeMembers).where(eq(bridgeMembers.bridgeId, row.id));
      const target = members.find((m) => m.slackUserId === slackUserId);
      if (!target) return void res.status(404).json({ error: "not a member of this bridge" });
      // Never strip a bridge of its last admin: a superadmin would have to hand it back.
      if (target.role === "admin" && members.filter((m) => m.role === "admin").length === 1) {
        return badRequest(res, "this is the bridge's only admin; add another admin first");
      }
      await db.delete(bridgeMembers).where(and(eq(bridgeMembers.bridgeId, row.id), eq(bridgeMembers.slackUserId, slackUserId)));
      log.info("bridge member removed", { bridge: row.name, slackUserId, by: actorOf(req).slackUserId });
      res.status(204).end();
    }),
  );

  // ---- helper roster: who answers tickets, and who that makes an agent in Chatwoot ----

  /**
   * Load the bridge and its live registry entry for a helper action. Provisioning creates and
   * removes Chatwoot accounts, so it needs a bridge admin rather than merely an operator.
   */
  async function helperBridgeFor(req: Request, res: Response, need: "configure" | "administer" = "administer") {
    const row = await bridgeFor(req, res, need);
    if (!row) return undefined;
    if (!row.helperChannel) {
      badRequest(res, "this bridge has no helper channel yet");
      return undefined;
    }
    const bridge = ctx.bridges.get(row.id);
    if (!bridge) {
      badRequest(res, "this bridge is disabled or failed to load, so its Slack and Chatwoot clients are unavailable");
      return undefined;
    }
    return bridge;
  }

  /** The tracked roster and its history — cheap, no Slack or Chatwoot calls. */
  api.get(
    "/bridges/:id/helpers",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "configure");
      if (!row) return;
      const [members, events] = await Promise.all([listHelperMembers(db, row.id), listHelperEvents(db, row.id)]);
      res.json({
        canProvision: canAdministerBridge(actorOf(req), row.id),
        channel: row.helperChannel,
        autoProvision: row.helperAutoProvision,
        offboarding: row.helperOffboarding,
        maxBatch: row.helperMaxBatch,
        chatwootRole: row.helperChatwootRole,
        linkPrompt: row.helperLinkPrompt,
        paused: row.helperPausedAt ? { at: row.helperPausedAt, reason: row.helperPausedReason } : null,
        members,
        events,
      });
    }),
  );

  /**
   * Read the helper channel and work out what provisioning each person would actually do. This
   * is a POST because it reconciles who is still in the channel, but it never provisions or
   * unlinks anybody — that always takes a second, explicit request naming the people.
   */
  api.post(
    "/bridges/:id/helpers/review",
    wrap(async (req, res) => {
      const bridge = await helperBridgeFor(req, res, "configure");
      if (!bridge) return;
      try {
        res.json({ ...(await reviewHelpers(ctx, bridge)), canProvision: canAdministerBridge(actorOf(req), bridge.row.id) });
      } catch (err) {
        badRequest(res, `Could not read ${bridge.row.helperChannel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  /**
   * Provision the named people and nobody else. `expected` is the count the reviewer saw on
   * screen; a mismatch means the list they approved is not the list that arrived, so we refuse
   * rather than guess. The per-bridge batch limit is enforced again inside `provisionHelpers`.
   */
  api.post(
    "/bridges/:id/helpers/provision",
    wrap(async (req, res) => {
      const bridge = await helperBridgeFor(req, res);
      if (!bridge) return;
      const input = z
        .object({ slackUserIds: z.array(z.string().trim().regex(SLACK_USER_RE)).min(1).max(200), expected: z.number().int().nonnegative() })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const ids = [...new Set(input.data.slackUserIds)];
      if (ids.length !== input.data.expected) {
        return badRequest(res, `you approved ${input.data.expected} ${input.data.expected === 1 ? "person" : "people"} but ${ids.length} arrived; review the list again`);
      }
      try {
        const results = await provisionHelpers(ctx, bridge, ids, { actor: actorOf(req).slackUserId });
        res.json({ results });
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  /**
   * Ask the named people to link their account, instead of inviting a guessed address. Same
   * approve-the-exact-count contract as provisioning, because this sends real direct messages.
   */
  api.post(
    "/bridges/:id/helpers/ask",
    wrap(async (req, res) => {
      const bridge = await helperBridgeFor(req, res);
      if (!bridge) return;
      const input = z
        .object({ slackUserIds: z.array(z.string().trim().regex(SLACK_USER_RE)).min(1).max(200), expected: z.number().int().nonnegative() })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const ids = [...new Set(input.data.slackUserIds)];
      if (ids.length !== input.data.expected) {
        return badRequest(res, `you approved ${input.data.expected} ${input.data.expected === 1 ? "person" : "people"} but ${ids.length} arrived; review the list again`);
      }
      try {
        res.json({ results: await askHelpersToLink(ctx, bridge, ids, { actor: actorOf(req).slackUserId }) });
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  /** Take one person off this bridge's Chatwoot account. Their Chatwoot user is never deleted. */
  api.post(
    "/bridges/:id/helpers/:slackUserId/unlink",
    wrap(async (req, res) => {
      const bridge = await helperBridgeFor(req, res);
      if (!bridge) return;
      try {
        res.json({ detail: await unlinkHelper(ctx, bridge, String(req.params.slackUserId), actorOf(req).slackUserId) });
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  /** "Not this one." Keeps them off every future automatic run until somebody undoes it. */
  api.post(
    "/bridges/:id/helpers/:slackUserId/skip",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      await skipHelper(ctx, row.id, String(req.params.slackUserId), actorOf(req).slackUserId);
      res.status(204).end();
    }),
  );

  api.delete(
    "/bridges/:id/helpers/:slackUserId/skip",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      await unskipHelper(ctx, row.id, String(req.params.slackUserId), actorOf(req).slackUserId);
      res.status(204).end();
    }),
  );

  /** Clear the burst guard. Nobody who joined while it was tripped is provisioned retroactively. */
  api.post(
    "/bridges/:id/helpers/resume",
    wrap(async (req, res) => {
      const row = await bridgeFor(req, res, "administer");
      if (!row) return;
      await resumeHelperAutoProvision(ctx, row.id, actorOf(req).slackUserId);
      res.status(204).end();
    }),
  );

  /** Paste a Chatwoot access token -> which accounts/API inboxes can it see? Powers the bridge form. */
  api.post(
    "/chatwoot/introspect",
    wrap(async (req, res) => {
      const token = z.object({ apiToken: z.string().trim().min(1) }).safeParse(req.body);
      if (!token.success) return badRequest(res, "apiToken required");
      const client = introspectClient(token.data.apiToken);
      try {
        const profile = await client.whoAmI(token.data.apiToken);
        const accounts = await Promise.all(
          (profile.accounts ?? []).map(async (a) => {
            const inboxes = await client.listInboxes(a.id, token.data.apiToken).catch(() => []);
            return {
              id: a.id,
              name: a.name,
              role: a.role,
              inboxes: inboxes.filter((i) => i.channel_type === "Channel::Api").map((i) => ({ id: i.id, name: i.name, inboxIdentifier: i.inbox_identifier })),
            };
          }),
        );
        res.json({ profile: { id: profile.id, name: profile.name, email: profile.email }, accounts });
      } catch (err) {
        if (err instanceof ChatwootHttpError && err.status === 401) return badRequest(res, "Chatwoot rejected that token");
        throw err;
      }
    }),
  );

  /** Paste a bridge's bot token (or name an existing bridge) -> bot identity, and optionally check one channel ID. */
  api.post(
    "/slack/introspect",
    wrap(async (req, res) => {
      const input = z
        .object({ botToken: z.string().trim().min(1).optional(), bridgeId: z.number().int().optional(), channel: z.string().trim().optional() })
        .safeParse(req.body);
      if (!input.success || (!input.data.botToken && !input.data.bridgeId)) return badRequest(res, "botToken or bridgeId required");
      if (input.data.bridgeId !== undefined && !canConfigureBridge(actorOf(req), input.data.bridgeId)) {
        return void res.status(404).json({ error: "not found" });
      }
      const client = input.data.botToken ? slackClient(input.data.botToken) : ctx.bridges.get(input.data.bridgeId!)?.slack;
      if (!client) return badRequest(res, "bridge not loaded");
      let auth;
      try {
        auth = await client.auth.test();
      } catch (err) {
        return badRequest(res, `Slack rejected that token: ${err instanceof Error ? err.message : String(err)}`);
      }
      let channel: { id: string; name?: string; isMember: boolean; error?: string } | undefined;
      if (input.data.channel && /^[CG][A-Z0-9]+$/.test(input.data.channel)) {
        try {
          const info = await client.conversations.info({ channel: input.data.channel });
          channel = { id: input.data.channel, name: info.channel?.name, isMember: Boolean(info.channel?.is_member) };
        } catch (err) {
          channel = { id: input.data.channel, isMember: false, error: (err as { data?: { error?: string } })?.data?.error ?? (err as Error).message };
        }
      }
      res.json({ bot: { userId: auth.user_id, botId: auth.bot_id, name: auth.user, team: auth.team }, channel });
    }),
  );

  // ---- the roster: who may sign in at all (superadmins only) ----

  /**
   * Global roles. `superadmin` runs the install, `admin` may create bridges of their own, and
   * `operator` may only do what a bridge admin has invited them to do. Bridge-level grants are
   * managed by each bridge's admins under /bridges/:id/members and are untouched here.
   */
  api.get(
    "/people",
    wrap(async (req, res) => {
      if (!guard(req, res, isSuper(actorOf(req)), "only a superadmin can see the roster")) return;
      const rows = await db.select().from(adminUsers).orderBy(adminUsers.createdAt);
      const members = await db.select().from(bridgeMembers);
      const bridgeNames = new Map((await db.select().from(bridges)).map((b) => [b.id, b.name]));
      res.json(
        rows.map((u) => ({
          slackUserId: u.slackUserId,
          name: u.name,
          role: u.role,
          invitedBy: u.invitedBy,
          lastSeenAt: u.lastSeenAt,
          createdAt: u.createdAt,
          bridges: members
            .filter((m) => m.slackUserId === u.slackUserId)
            .map((m) => ({ id: m.bridgeId, name: bridgeNames.get(m.bridgeId) ?? null, role: m.role })),
        })),
      );
    }),
  );

  const roleInput = z.object({ role: z.enum(["superadmin", "admin", "operator"]) });

  api.post(
    "/people",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      if (!guard(req, res, isSuper(actor), "only a superadmin can add people")) return;
      const input = roleInput
        .extend({ slackUserId: z.string().trim().regex(SLACK_USER_RE, "Slack user ID like U0123456789") })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const [row] = await db
        .insert(adminUsers)
        .values({ slackUserId: input.data.slackUserId, role: input.data.role, invitedBy: actor.slackUserId })
        .onConflictDoUpdate({ target: adminUsers.slackUserId, set: { role: input.data.role } })
        .returning();
      log.info("roster entry added", { slackUserId: input.data.slackUserId, role: input.data.role, by: actor.slackUserId });
      res.status(201).json({ slackUserId: row!.slackUserId, name: row!.name, role: row!.role });
    }),
  );

  api.put(
    "/people/:slackUserId",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      if (!guard(req, res, isSuper(actor), "only a superadmin can change roles")) return;
      const input = roleInput.safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const slackUserId = String(req.params.slackUserId);
      const blocked = await lastSuperadminGuard(slackUserId, input.data.role);
      if (blocked) return badRequest(res, blocked);
      const [row] = await db.update(adminUsers).set({ role: input.data.role }).where(eq(adminUsers.slackUserId, slackUserId)).returning();
      if (!row) return void res.status(404).json({ error: "not on the roster" });
      log.info("roster role changed", { slackUserId, role: input.data.role, by: actor.slackUserId });
      res.json({ slackUserId: row.slackUserId, name: row.name, role: row.role });
    }),
  );

  api.delete(
    "/people/:slackUserId",
    wrap(async (req, res) => {
      const actor = actorOf(req);
      if (!guard(req, res, isSuper(actor), "only a superadmin can remove people")) return;
      const slackUserId = String(req.params.slackUserId);
      const blocked = await lastSuperadminGuard(slackUserId, "operator");
      if (blocked) return badRequest(res, blocked);
      // Removing someone takes their bridge grants with them; their agent link is left alone,
      // since that governs ticket attribution rather than panel access.
      await db.delete(bridgeMembers).where(eq(bridgeMembers.slackUserId, slackUserId));
      await db.delete(adminUsers).where(eq(adminUsers.slackUserId, slackUserId));
      log.info("roster entry removed", { slackUserId, by: actor.slackUserId });
      res.status(204).end();
    }),
  );

  /** Refuse anything that would leave the install with no superadmin. Returns a reason or undefined. */
  async function lastSuperadminGuard(slackUserId: string, nextRole: string): Promise<string | undefined> {
    if (nextRole === "superadmin") return undefined;
    const supers = await db.select().from(adminUsers).where(eq(adminUsers.role, "superadmin"));
    if (supers.length === 1 && supers[0]!.slackUserId === slackUserId) return "this is the last superadmin; promote someone else first";
    return undefined;
  }

  // ---- agents ----

  const redactAgent = (a: typeof agents.$inferSelect) => ({
    id: a.id,
    slackUserId: a.slackUserId,
    chatwootAgentId: a.chatwootAgentId,
    email: a.email,
    emailSource: a.emailSource,
    hasSlackToken: Boolean(a.slackUserTokenEnc),
    hasChatwootToken: Boolean(a.chatwootApiTokenEnc),
    createdAt: a.createdAt,
  });

  /**
   * The people this viewer has any business seeing: everyone, for a superadmin, and otherwise
   * whoever is either a Chatwoot agent in one of their bridges' accounts or a Slack user who
   * has actually asked something in one of their channels.
   */
  async function visibleAgents(actor: Actor): Promise<(typeof agents.$inferSelect)[]> {
    const all = await db.select().from(agents).orderBy(desc(agents.createdAt));
    if (isSuper(actor)) return all;
    const scope = await scopeOf(actor);
    if (scope.all) return all;
    const chatwootIds = new Set((await listChatwootAgents(ctx, scope.bridgeIds ?? [])).map((a) => a.id));
    const askers = new Set(
      scope.channels.length
        ? (await db.selectDistinct({ user: threads.slackAuthorId }).from(threads).where(inArray(threads.slackChannel, scope.channels))).map((r) => r.user)
        : [],
    );
    return all.filter((a) => (a.chatwootAgentId !== null && chatwootIds.has(a.chatwootAgentId)) || askers.has(a.slackUserId));
  }

  /** Load an agent row the viewer may act on, or reply 404. */
  async function agentFor(req: Request, res: Response) {
    const id = Number(req.params.id);
    const row = (await visibleAgents(actorOf(req))).find((a) => a.id === id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return undefined;
    }
    return row;
  }

  api.get(
    "/agents",
    wrap(async (req, res) => {
      res.json((await visibleAgents(actorOf(req))).map(redactAgent));
    }),
  );

  /** Pre-create an agent row for a Slack user (e.g. to attach a Chatwoot token before they run /link). */
  api.post(
    "/agents",
    wrap(async (req, res) => {
      const input = z.object({ slackUserId: z.string().trim().regex(/^[UW][A-Z0-9]+$/) }).safeParse(req.body);
      if (!input.success) return badRequest(res, "slackUserId must be a Slack user ID");
      const [row] = await db.insert(agents).values({ slackUserId: input.data.slackUserId }).onConflictDoNothing().returning();
      const out = row ?? (await db.select().from(agents).where(eq(agents.slackUserId, input.data.slackUserId)))[0]!;
      res.status(201).json(redactAgent(out));
    }),
  );

  /** Chatwoot agents across every bridged account, for manual linking. */
  api.get(
    "/chatwoot/agents",
    wrap(async (req, res) => {
      const scope = await scopeOf(actorOf(req));
      res.json(await listChatwootAgents(ctx, scope.bridgeIds));
    }),
  );

  /**
   * Manually set (or clear) which Chatwoot agent a Slack user is, by id or by email match.
   * For when the automatic email match at /link fails (different emails on each side).
   */
  api.put(
    "/agents/:id/chatwoot-agent",
    wrap(async (req, res) => {
      const target = await agentFor(req, res);
      if (!target) return;
      const id = target.id;
      const scope = await scopeOf(actorOf(req));
      const input = z
        .object({ chatwootAgentId: z.number().int().positive().nullable().optional(), email: z.string().trim().email().optional() })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      let agentId = input.data.chatwootAgentId;
      let email: string | null | undefined;
      if (input.data.email) {
        const all = await listChatwootAgents(ctx, scope.bridgeIds);
        const hit = all.find((a) => a.email?.toLowerCase() === input.data.email!.toLowerCase());
        if (!hit) return badRequest(res, `No Chatwoot agent with email ${input.data.email} in any bridged account`);
        agentId = hit.id;
        email = hit.email;
      } else if (agentId) {
        const all = await listChatwootAgents(ctx, scope.bridgeIds);
        const hit = all.find((a) => a.id === agentId);
        if (!hit) return badRequest(res, `Chatwoot agent ${agentId} is not in any bridged account`);
        email = hit.email;
      } else if (agentId === undefined) {
        return badRequest(res, "chatwootAgentId or email required");
      }
      const [row] = await db
        .update(agents)
        // A human picked this Chatwoot user, so the address on it is theirs — record that, or the
        // helper roster goes on treating a Slack profile address as the only thing it has.
        .set({ chatwootAgentId: agentId ?? null, ...(email !== undefined ? { email, emailSource: "admin" as const } : {}) })
        .where(eq(agents.id, id))
        .returning();
      if (!row) return void res.status(404).json({ error: "not found" });
      log.info("agent link set manually", { agentRow: id, chatwootAgentId: agentId, by: actorOf(req).slackUserId });
      res.json(redactAgent(row));
    }),
  );

  api.put(
    "/agents/:id/chatwoot-token",
    wrap(async (req, res) => {
      const target = await agentFor(req, res);
      if (!target) return;
      const id = target.id;
      const input = z.object({ apiToken: z.string().trim().min(1) }).safeParse(req.body);
      if (!input.success) return badRequest(res, "apiToken required");
      let profile;
      try {
        profile = await introspectClient(input.data.apiToken).whoAmI(input.data.apiToken);
      } catch (err) {
        if (err instanceof ChatwootHttpError && err.status === 401) return badRequest(res, "Chatwoot rejected that token");
        throw err;
      }
      const [row] = await db
        .update(agents)
        .set({ chatwootApiTokenEnc: enc(input.data.apiToken), chatwootAgentId: profile.id, email: profile.email ?? null, emailSource: profile.email ? ("chatwoot" as const) : null })
        .where(eq(agents.id, id))
        .returning();
      if (!row) return void res.status(404).json({ error: "not found" });
      res.json(redactAgent(row));
    }),
  );

  api.delete(
    "/agents/:id/chatwoot-token",
    wrap(async (req, res) => {
      const target = await agentFor(req, res);
      if (!target) return;
      await db.update(agents).set({ chatwootApiTokenEnc: null }).where(eq(agents.id, target.id));
      res.status(204).end();
    }),
  );

  api.delete(
    "/agents/:id",
    wrap(async (req, res) => {
      const target = await agentFor(req, res);
      if (!target) return;
      await db.delete(agents).where(eq(agents.id, target.id));
      res.status(204).end();
    }),
  );

  // ---- ops ----

  api.get(
    "/threads",
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const scope = await scopeOf(actorOf(req));
      const rows = await db
        .select()
        .from(threads)
        .where(scope.channelFilter(threads.slackChannel))
        .orderBy(desc(threads.createdAt))
        .limit(limit);
      res.json(rows.map((t) => ({ ...t, bridge: ctx.bridges.forChannel(t.slackChannel)?.row.name ?? null })));
    }),
  );

  /**
   * Queued jobs the viewer may see. Slack jobs name a channel and Chatwoot jobs name an
   * account or inbox, which is enough to attribute nearly all of them to a bridge; anything
   * that cannot be attributed stays with the superadmins.
   */
  async function visibleRetries(actor: Actor): Promise<(typeof retries.$inferSelect)[]> {
    const rows = await db.select().from(retries).orderBy(retries.nextAttemptAt);
    if (isSuper(actor)) return rows;
    const scope = await scopeOf(actor);
    if (scope.all) return rows;
    const channels = new Set(scope.channels);
    const accounts = new Set(scope.accounts);
    const inboxes = new Set(scope.rows.map((b) => b.chatwootInboxId).filter((i): i is number => i !== null));
    return rows.filter((r) => {
      const p = r.payload as { channel?: unknown; accountId?: unknown; inboxId?: unknown };
      if (typeof p.channel === "string") return channels.has(p.channel);
      if (typeof p.accountId === "number" && accounts.has(p.accountId)) return true;
      if (typeof p.inboxId === "number" && inboxes.has(p.inboxId)) return true;
      return false;
    });
  }

  api.get(
    "/retries",
    wrap(async (req, res) => {
      res.json(await visibleRetries(actorOf(req)));
    }),
  );

  /** A retry the viewer may act on, or 404. */
  async function retryFor(req: Request, res: Response) {
    const id = Number(req.params.id);
    const row = (await visibleRetries(actorOf(req))).find((r) => r.id === id);
    if (!row) {
      res.status(404).json({ error: "not found" });
      return undefined;
    }
    return row;
  }

  api.post(
    "/retries/:id/run",
    wrap(async (req, res) => {
      const row = await retryFor(req, res);
      if (!row) return;
      await db.update(retries).set({ nextAttemptAt: new Date() }).where(eq(retries.id, row.id));
      await ctx.retry.drain();
      res.status(204).end();
    }),
  );

  api.delete(
    "/retries/:id",
    wrap(async (req, res) => {
      const row = await retryFor(req, res);
      if (!row) return;
      await db.delete(retries).where(eq(retries.id, row.id));
      res.status(204).end();
    }),
  );

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error("admin api error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  router.use("/admin/api", api);
}

export interface ChatwootAgentSummary {
  id: number;
  name: string;
  email: string | null;
  accounts: number[];
}

/** Union of agents across the given bridges' accounts (all of them when `bridgeIds` is null). */
export async function listChatwootAgents(ctx: AppContext, bridgeIds: number[] | null = null): Promise<ChatwootAgentSummary[]> {
  const byId = new Map<number, ChatwootAgentSummary>();
  const seenAccounts = new Set<number>();
  const allowed = bridgeIds === null ? null : new Set(bridgeIds);
  for (const bridge of ctx.bridges.all()) {
    if (allowed && !allowed.has(bridge.row.id)) continue;
    const acct = bridge.row.chatwootAccountId;
    if (seenAccounts.has(acct)) continue;
    seenAccounts.add(acct);
    let list;
    try {
      list = await bridge.chatwoot.listAgents();
    } catch (err) {
      log.warn("listAgents failed", { bridge: bridge.row.name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const a of list) {
      const cur = byId.get(a.id) ?? { id: a.id, name: a.name, email: a.email ?? null, accounts: [] };
      cur.accounts.push(acct);
      byId.set(a.id, cur);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Does this token belong to a member of `accountId`, and does that account have an API inbox with this identifier? Returns an error string or the inbox id. */
async function verifyServiceToken(client: ChatwootClient, accountId: number, inboxIdentifier: string, token: string): Promise<string | { inboxId: number }> {
  try {
    const profile = await client.whoAmI(token);
    if (profile.accounts && !profile.accounts.some((a) => a.id === accountId)) return `That token's user is not a member of Chatwoot account ${accountId}`;
    const inboxes = await client.listInboxes(accountId, token);
    const inbox = inboxes.find((i) => i.inbox_identifier === inboxIdentifier);
    if (!inbox) return `No API inbox with identifier "${inboxIdentifier}" in account ${accountId}`;
    return { inboxId: inbox.id };
  } catch (err) {
    if (err instanceof ChatwootHttpError && err.status === 401) return "Chatwoot rejected that token";
    return `Could not verify with Chatwoot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Is this a working bot token, and is the bot in the channel? (Membership is a warning, not an error.) */
async function verifyBotToken(
  client: WebClient,
  channel: string,
): Promise<{ botId: string; botUserId: string; teamId?: string; warning?: string } | { error: string }> {
  try {
    const auth = await client.auth.test();
    const ids = await defaultAuthTest(client);
    let warning: string | undefined;
    try {
      const info = await client.conversations.info({ channel });
      if (!info.channel?.is_member) warning = `The bot is not a member of ${info.channel?.name ? `#${info.channel.name}` : channel} yet; invite it before enabling.`;
    } catch {
      warning = `Could not read channel ${channel} with this bot (missing channels:read, or the bot cannot see it).`;
    }
    return { ...ids, teamId: auth.team_id, warning };
  } catch (err) {
    return { error: `Slack rejected that bot token: ${err instanceof Error ? err.message : String(err)}` };
  }
}
