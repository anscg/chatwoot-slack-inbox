import { WebClient } from "@slack/web-api";
import { desc, eq, sql } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { defaultAuthTest } from "../bridges.js";
import { ChatwootClient, ChatwootHttpError } from "../chatwoot/client.js";
import type { AppContext } from "../context.js";
import { encryptToken } from "../crypto.js";
import { agents, bridges, relayed, retries, threads } from "../db/schema.js";
import { log } from "../logger.js";
import { ADMIN_COOKIE, parseCookies, Signer, type AdminSession } from "../session.js";
import { bridgeManifest, SLUG_RE, slugify } from "../slack/manifest.js";

const reactionField = z
  .string()
  .trim()
  .transform((s) => s.replace(/^:|:$/g, ""))
  .refine((s) => s === "" || /^[a-z0-9_+'-]+$/i.test(s), "emoji short name only, e.g. white_check_mark")
  .transform((s) => (s === "" ? null : s))
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
  enabled: z.boolean().optional(),
});

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const badRequest = (res: Response, error: string) => void res.status(400).json({ error });
const zodMsg = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

export function requireAdmin(signer: Signer) {
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
    (req as Request & { admin: AdminSession }).admin = session;
    next();
  };
}

export interface AdminApiOptions {
  /** Overridable for tests. */
  createSlackClient?: (token: string) => WebClient;
}

export function registerAdminApi(router: Router, ctx: AppContext, opts: AdminApiOptions = {}): void {
  const { config, db } = ctx;
  const signer = new Signer(config.TOKEN_ENCRYPTION_KEY);
  const api = express.Router();
  api.use(express.json({ limit: "256kb" }));
  api.use(requireAdmin(signer));

  const slackClient = opts.createSlackClient ?? ((t: string) => new WebClient(t));
  const introspectClient = (apiToken: string) => new ChatwootClient({ baseUrl: config.CHATWOOT_BASE_URL, accountId: 0, inboxIdentifier: "", apiToken });
  const enc = (v: string) => encryptToken(v, config.TOKEN_ENCRYPTION_KEY);

  api.get("/me", (req, res) => {
    res.json({ user: (req as Request & { admin: AdminSession }).admin, chatwootBaseUrl: config.CHATWOOT_BASE_URL, publicUrl: config.PUBLIC_URL });
  });

  api.get(
    "/status",
    wrap(async (_req, res) => {
      const [t, r, a, q] = await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(threads),
        db.select({ n: sql<number>`count(*)::int` }).from(relayed),
        db.select({ n: sql<number>`count(*)::int` }).from(agents),
        db.select({ n: sql<number>`count(*)::int` }).from(retries),
      ]);
      res.json({
        webhookUrl: `${config.PUBLIC_URL}/webhooks/chatwoot/${config.CHATWOOT_WEBHOOK_SECRET}`,
        linkUrl: `${config.PUBLIC_URL}/link`,
        counts: { threads: t[0]?.n ?? 0, relayed: r[0]?.n ?? 0, agents: a[0]?.n ?? 0, retries: q[0]?.n ?? 0 },
      });
    }),
  );

  // ---- bridges ----

  const redact = (b: typeof bridges.$inferSelect) => {
    const { chatwootApiTokenEnc: _c, slackBotTokenEnc: _b, slackSigningSecretEnc: _s, ...rest } = b;
    return { ...rest, hasChatwootToken: Boolean(b.chatwootApiTokenEnc), hasSlackApp: Boolean(b.slackBotTokenEnc), eventsUrl: `${config.PUBLIC_URL}/slack/events/${b.slug}` };
  };

  api.get(
    "/bridges",
    wrap(async (_req, res) => {
      res.json((await db.select().from(bridges).orderBy(bridges.name)).map(redact));
    }),
  );

  /** Manifest for a bridge's Slack app, before or after the bridge exists. */
  api.get("/manifest", (req, res) => {
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
      const input = bridgeInput.safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const d = input.data;
      if (!d.chatwootApiToken) return badRequest(res, "chatwootApiToken is required");
      if (!d.slackBotToken || !d.slackSigningSecret) return badRequest(res, "slackBotToken and slackSigningSecret are required");
      const cw = await verifyServiceToken(introspectClient(d.chatwootApiToken), d.chatwootAccountId, d.chatwootInboxIdentifier);
      if (cw) return badRequest(res, cw);
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
          chatwootApiTokenEnc: enc(d.chatwootApiToken),
          reactionResolve: d.reactionResolve === undefined ? "white_check_mark" : d.reactionResolve,
          reactionAssign: d.reactionAssign === undefined ? "eyes" : d.reactionAssign,
          enabled: d.enabled ?? true,
        })
        .returning();
      await ctx.bridges.reload();
      log.info("bridge created", { bridge: row!.name, by: (req as Request & { admin: AdminSession }).admin.userId });
      res.status(201).json({ ...redact(row!), warning: bot.warning });
    }),
  );

  api.put(
    "/bridges/:id",
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const input = bridgeInput.partial().safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      const existing = (await db.select().from(bridges).where(eq(bridges.id, id)))[0];
      if (!existing) return void res.status(404).json({ error: "not found" });
      const d = input.data;
      const accountId = d.chatwootAccountId ?? existing.chatwootAccountId;
      const inbox = d.chatwootInboxIdentifier ?? existing.chatwootInboxIdentifier;
      const channel = d.slackChannel ?? existing.slackChannel;
      if (d.chatwootApiToken) {
        const cw = await verifyServiceToken(introspectClient(d.chatwootApiToken), accountId, inbox);
        if (cw) return badRequest(res, cw);
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
          ...(d.chatwootApiToken ? { chatwootApiTokenEnc: enc(d.chatwootApiToken) } : {}),
          ...(d.reactionResolve !== undefined ? { reactionResolve: d.reactionResolve } : {}),
          ...(d.reactionAssign !== undefined ? { reactionAssign: d.reactionAssign } : {}),
          ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(bridges.id, id))
        .returning();
      await ctx.bridges.reload();
      res.json({ ...redact(row!), warning });
    }),
  );

  api.delete(
    "/bridges/:id",
    wrap(async (req, res) => {
      await db.delete(bridges).where(eq(bridges.id, Number(req.params.id)));
      await ctx.bridges.reload();
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

  // ---- agents ----

  const redactAgent = (a: typeof agents.$inferSelect) => ({
    id: a.id,
    slackUserId: a.slackUserId,
    chatwootAgentId: a.chatwootAgentId,
    email: a.email,
    hasSlackToken: Boolean(a.slackUserTokenEnc),
    hasChatwootToken: Boolean(a.chatwootApiTokenEnc),
    createdAt: a.createdAt,
  });

  api.get(
    "/agents",
    wrap(async (_req, res) => {
      res.json((await db.select().from(agents).orderBy(desc(agents.createdAt))).map(redactAgent));
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
    wrap(async (_req, res) => {
      res.json(await listChatwootAgents(ctx));
    }),
  );

  /**
   * Manually set (or clear) which Chatwoot agent a Slack user is, by id or by email match.
   * For when the automatic email match at /link fails (different emails on each side).
   */
  api.put(
    "/agents/:id/chatwoot-agent",
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const input = z
        .object({ chatwootAgentId: z.number().int().positive().nullable().optional(), email: z.string().trim().email().optional() })
        .safeParse(req.body);
      if (!input.success) return badRequest(res, zodMsg(input.error));
      let agentId = input.data.chatwootAgentId;
      let email: string | null | undefined;
      if (input.data.email) {
        const all = await listChatwootAgents(ctx);
        const hit = all.find((a) => a.email?.toLowerCase() === input.data.email!.toLowerCase());
        if (!hit) return badRequest(res, `No Chatwoot agent with email ${input.data.email} in any bridged account`);
        agentId = hit.id;
        email = hit.email;
      } else if (agentId) {
        const all = await listChatwootAgents(ctx);
        const hit = all.find((a) => a.id === agentId);
        if (!hit) return badRequest(res, `Chatwoot agent ${agentId} is not in any bridged account`);
        email = hit.email;
      } else if (agentId === undefined) {
        return badRequest(res, "chatwootAgentId or email required");
      }
      const [row] = await db
        .update(agents)
        .set({ chatwootAgentId: agentId ?? null, ...(email !== undefined ? { email } : {}) })
        .where(eq(agents.id, id))
        .returning();
      if (!row) return void res.status(404).json({ error: "not found" });
      log.info("agent link set manually", { agentRow: id, chatwootAgentId: agentId, by: (req as Request & { admin: AdminSession }).admin.userId });
      res.json(redactAgent(row));
    }),
  );

  api.put(
    "/agents/:id/chatwoot-token",
    wrap(async (req, res) => {
      const id = Number(req.params.id);
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
        .set({ chatwootApiTokenEnc: enc(input.data.apiToken), chatwootAgentId: profile.id, email: profile.email ?? null })
        .where(eq(agents.id, id))
        .returning();
      if (!row) return void res.status(404).json({ error: "not found" });
      res.json(redactAgent(row));
    }),
  );

  api.delete(
    "/agents/:id/chatwoot-token",
    wrap(async (req, res) => {
      await db.update(agents).set({ chatwootApiTokenEnc: null }).where(eq(agents.id, Number(req.params.id)));
      res.status(204).end();
    }),
  );

  api.delete(
    "/agents/:id",
    wrap(async (req, res) => {
      await db.delete(agents).where(eq(agents.id, Number(req.params.id)));
      res.status(204).end();
    }),
  );

  // ---- ops ----

  api.get(
    "/threads",
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const rows = await db.select().from(threads).orderBy(desc(threads.createdAt)).limit(limit);
      res.json(rows.map((t) => ({ ...t, bridge: ctx.bridges.forChannel(t.slackChannel)?.row.name ?? null })));
    }),
  );

  api.get(
    "/retries",
    wrap(async (_req, res) => {
      res.json(await db.select().from(retries).orderBy(retries.nextAttemptAt));
    }),
  );

  api.post(
    "/retries/:id/run",
    wrap(async (req, res) => {
      await db.update(retries).set({ nextAttemptAt: new Date() }).where(eq(retries.id, Number(req.params.id)));
      await ctx.retry.drain();
      res.status(204).end();
    }),
  );

  api.delete(
    "/retries/:id",
    wrap(async (req, res) => {
      await db.delete(retries).where(eq(retries.id, Number(req.params.id)));
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

/** Union of agents across all enabled bridges' accounts (Chatwoot user ids are global per install). */
export async function listChatwootAgents(ctx: AppContext): Promise<ChatwootAgentSummary[]> {
  const byId = new Map<number, ChatwootAgentSummary>();
  const seenAccounts = new Set<number>();
  for (const bridge of ctx.bridges.all()) {
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

/** Does this token belong to a member of `accountId`, and does that account have an API inbox with this identifier? */
async function verifyServiceToken(client: ChatwootClient, accountId: number, inboxIdentifier: string): Promise<string | null> {
  const token = client["opts"].apiToken;
  try {
    const profile = await client.whoAmI(token);
    if (profile.accounts && !profile.accounts.some((a) => a.id === accountId)) return `That token's user is not a member of Chatwoot account ${accountId}`;
    const inboxes = await client.listInboxes(accountId, token);
    if (!inboxes.find((i) => i.inbox_identifier === inboxIdentifier)) return `No API inbox with identifier "${inboxIdentifier}" in account ${accountId}`;
    return null;
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
