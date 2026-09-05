import { and, count, desc, eq, gte } from "drizzle-orm";
import type { Bridge } from "./bridges.js";
import { ChatwootHttpError, type ChatwootAgent } from "./chatwoot/client.js";
import type { AppContext } from "./context.js";
import type { Db } from "./db/client.js";
import { helperEvents, helperMembers, bridges, type HelperMember, type HelperState } from "./db/schema.js";
import { log } from "./logger.js";
import { HELPER_LINK_ASK_COOLDOWN_MS } from "./messages.js";
import { PermanentError } from "./retry.js";
import { findAgentBySlackUser } from "./store.js";
import { postDirectMessage } from "./slack/post.js";
import { getSlackProfile } from "./slack/users.js";

export const JOB_HELPER_JOINED = "helper_joined";
export const JOB_HELPER_LEFT = "helper_left";

/** Joins inside this window count towards the burst guard. */
export const HELPER_BURST_WINDOW_MS = 10 * 60_000;
/** Never read more of a channel than this when reviewing; a helper channel is not a #general. */
export const HELPER_PREVIEW_LIMIT = 500;
/** Slack profile lookups in flight at once while reviewing. */
const PROFILE_CONCURRENCY = 4;

export interface HelperJoinedJob extends Record<string, unknown> {
  bridgeId: number;
  slackUserId: string;
}
export type HelperLeftJob = HelperJoinedJob;

/**
 * What provisioning this person would actually do in Chatwoot — the distinction the whole
 * review screen is built around.
 *   member   — already an agent on this account; provisioning only records the fact.
 *   existing — Chatwoot has a user for them; they get added to this account, no invite, no new login.
 *   invite   — Chatwoot has never seen this address: a new user is created and emailed an invitation.
 *   blocked  — nothing we can do: a bot, or no email to key a Chatwoot user on.
 */
export type HelperBucket = "member" | "existing" | "invite" | "blocked";

export interface HelperCandidate {
  slackUserId: string;
  name: string;
  email: string | null;
  /**
   * How much the address is worth trusting, straight from `agents.emailSource` where we have it.
   * `chatwoot` means it belongs to a Chatwoot user we matched them to; `hackclub` means Hack Club
   * Auth handed it over verified, so it is the address they sign in to Chatwoot with; `admin`
   * means a human set it; `slack` means it is just their Slack profile address and nothing has
   * ever confirmed Chatwoot knows it.
   */
  emailSource: "chatwoot" | "hackclub" | "admin" | "slack" | null;
  chatwootUserId: number | null;
  bucket: HelperBucket;
  /** Why they are blocked, or what provisioning them would do. */
  reason: string;
  /** Their tracked state, or null if this bridge has never seen them. */
  state: HelperState | null;
  inChannel: boolean;
  /** When we last asked them to link, so the panel does not offer to nag them again. */
  linkAskedAt: string | null;
}

/**
 * Is their Chatwoot identity actually known, or would provisioning them be a guess? Only a match
 * to a real Chatwoot user counts. Everyone else is somebody to ask, not somebody to invite.
 */
export function isConfirmed(c: HelperCandidate): boolean {
  return c.bucket === "member" || c.bucket === "existing";
}

export interface AskResult {
  slackUserId: string;
  ok: boolean;
  detail: string;
}

export interface HelperReview {
  channel: string;
  /** Members Slack reports in the helper channel, bots included. */
  memberCount: number;
  /** True when the channel is larger than we are willing to read; `candidates` is then partial. */
  truncated: boolean;
  maxBatch: number;
  autoProvision: "off" | "existing" | "all";
  offboarding: "keep" | "unlink";
  paused: { at: string; reason: string } | null;
  /** Whether the bridge's Chatwoot service token may actually add agents to the account. */
  serviceToken: { role: string | null; canProvision: boolean; error?: string };
  candidates: HelperCandidate[];
  /** People tracked as provisioned who are no longer in the channel. */
  departed: HelperCandidate[];
}

export interface ProvisionResult {
  slackUserId: string;
  ok: boolean;
  bucket: HelperBucket;
  /** What was done, or why it was not. */
  detail: string;
  chatwootUserId?: number;
}

// ---------- roster storage ----------

export async function listHelperMembers(db: Db, bridgeId: number): Promise<HelperMember[]> {
  return db.select().from(helperMembers).where(eq(helperMembers.bridgeId, bridgeId)).orderBy(helperMembers.slackUserId);
}

export async function findHelperMember(db: Db, bridgeId: number, slackUserId: string): Promise<HelperMember | undefined> {
  const rows = await db
    .select()
    .from(helperMembers)
    .where(and(eq(helperMembers.bridgeId, bridgeId), eq(helperMembers.slackUserId, slackUserId)))
    .limit(1);
  return rows[0];
}

export async function listHelperEvents(db: Db, bridgeId: number, limit = 50) {
  return db.select().from(helperEvents).where(eq(helperEvents.bridgeId, bridgeId)).orderBy(desc(helperEvents.createdAt)).limit(limit);
}

async function note(
  db: Db,
  bridgeId: number,
  action: (typeof helperEvents.$inferInsert)["action"],
  slackUserId: string | null,
  detail: string,
  actor: string | null,
): Promise<void> {
  await db.insert(helperEvents).values({ bridgeId, slackUserId, action, detail, actor });
}

/** Create or update the tracked row. Rows are only ever written here, never deleted. */
async function upsertHelper(db: Db, bridgeId: number, slackUserId: string, patch: Partial<typeof helperMembers.$inferInsert>): Promise<HelperMember> {
  const values = { bridgeId, slackUserId, ...patch, updatedAt: new Date() };
  const rows = await db
    .insert(helperMembers)
    .values(values)
    .onConflictDoUpdate({ target: [helperMembers.bridgeId, helperMembers.slackUserId], set: { ...patch, updatedAt: new Date() } })
    .returning();
  const out = rows[0];
  if (!out) throw new Error("helper upsert returned no row");
  return out;
}

// ---------- resolving people ----------

interface Directory {
  /** Agents on this bridge's Chatwoot account, keyed by lowercased email. */
  byEmail: Map<string, ChatwootAgent>;
  byId: Map<number, ChatwootAgent>;
}

async function directory(bridge: Bridge): Promise<Directory> {
  const list = await bridge.chatwoot.listAgents();
  return {
    byEmail: new Map(list.filter((a) => a.email).map((a) => [a.email.toLowerCase(), a])),
    byId: new Map(list.map((a) => [a.id, a])),
  };
}

/**
 * Work out what this Slack user is to Chatwoot. The email is taken from their linked account
 * first and their Slack profile only as a fallback, because a Hack Club account's Chatwoot
 * address is often not the one on their Slack profile — inviting the Slack one would hand them a
 * second Chatwoot login rather than the account they already use.
 */
async function resolve(ctx: AppContext, bridge: Bridge, slackUserId: string, dir: Directory, tracked?: HelperMember): Promise<HelperCandidate> {
  const base = {
    slackUserId,
    state: tracked?.state ?? null,
    inChannel: tracked?.inChannel ?? true,
    linkAskedAt: tracked?.linkAskedAt?.toISOString() ?? null,
  };
  let name = tracked?.name ?? slackUserId;
  let slackEmail: string | undefined;
  try {
    const profile = await getSlackProfile(bridge.slack, slackUserId);
    name = profile.name;
    slackEmail = profile.email;
    if (profile.isBot) {
      return { ...base, name, email: null, emailSource: null, chatwootUserId: null, bucket: "blocked", reason: "a bot, not a person" };
    }
  } catch (err) {
    log.warn("could not read a helper's Slack profile", { slackUserId, error: err instanceof Error ? err.message : String(err) });
  }

  const linked = await findAgentBySlackUser(ctx.db, slackUserId);
  const email = linked?.email ?? slackEmail ?? null;
  // /link records where the address came from. Rows written before it did fall back to the old
  // guess: a stored address that differs from Slack's must have come from somewhere better.
  const emailSource: HelperCandidate["emailSource"] = !email
    ? null
    : linked?.chatwootAgentId
      ? "chatwoot"
      : (linked?.email ? linked.emailSource : null) ??
        (linked?.email && linked.email.toLowerCase() !== slackEmail?.toLowerCase() ? "hackclub" : "slack");

  // Already on the account, either by the Chatwoot user we know them as or by their address.
  const byId = linked?.chatwootAgentId ? dir.byId.get(linked.chatwootAgentId) : undefined;
  const byEmail = email ? dir.byEmail.get(email.toLowerCase()) : undefined;
  const onAccount = byId ?? byEmail;
  if (onAccount) {
    return { ...base, name, email: onAccount.email ?? email, emailSource, chatwootUserId: onAccount.id, bucket: "member", reason: "already an agent on this account" };
  }
  if (!email) {
    return { ...base, name, email: null, emailSource: null, chatwootUserId: null, bucket: "blocked", reason: "no email on their Slack profile, and they have not linked their account" };
  }
  if (linked?.chatwootAgentId) {
    return { ...base, name, email, emailSource, chatwootUserId: linked.chatwootAgentId, bucket: "existing", reason: `Chatwoot already knows ${email}; they are added to this account without an invitation` };
  }
  return {
    ...base,
    name,
    email,
    emailSource,
    chatwootUserId: null,
    bucket: "invite",
    reason:
      emailSource === "slack"
        ? `creates a new Chatwoot user for ${email} and emails them an invitation — nothing has confirmed Chatwoot knows that address, so if they sign in with a different one this makes them a second account`
        : `creates a new Chatwoot user for ${email} and emails them an invitation`,
  };
}

/** Slack's members list for a channel, paginated, stopping at HELPER_PREVIEW_LIMIT. */
async function channelMembers(bridge: Bridge, channel: string): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await bridge.slack.conversations.members({ channel, limit: 200, cursor });
    ids.push(...(res.members ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (ids.length >= HELPER_PREVIEW_LIMIT) return { ids: ids.slice(0, HELPER_PREVIEW_LIMIT), truncated: true };
  } while (cursor);
  return { ids, truncated: false };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Everything the review screen needs, and the only place channel membership is reconciled.
 * Reads only: someone who left while we were not listening is marked as out of the channel, but
 * nothing is provisioned or unlinked here. Provisioning is always a separate, explicit request.
 */
export async function reviewHelpers(ctx: AppContext, bridge: Bridge): Promise<HelperReview> {
  const row = bridge.row;
  if (!row.helperChannel) throw new PermanentError("this bridge has no helper channel");
  const [{ ids, truncated }, dir, serviceToken] = await Promise.all([
    channelMembers(bridge, row.helperChannel),
    directory(bridge),
    serviceTokenRole(bridge),
  ]);
  const tracked = new Map((await listHelperMembers(ctx.db, row.id)).map((m) => [m.slackUserId, m]));
  const present = new Set(ids);

  const candidates = await mapLimit(ids, PROFILE_CONCURRENCY, (id) => resolve(ctx, bridge, id, dir, tracked.get(id)));
  for (const c of candidates) c.inChannel = true;

  // Anyone we track who is not in the list has left; record that, but leave Chatwoot alone.
  const departed: HelperCandidate[] = [];
  for (const m of tracked.values()) {
    if (present.has(m.slackUserId)) continue;
    if (m.inChannel) {
      await upsertHelper(ctx.db, row.id, m.slackUserId, { inChannel: false, leftAt: m.leftAt ?? new Date() });
      await note(ctx.db, row.id, "left", m.slackUserId, "noticed during a roster review", null);
    }
    const c = await resolve(ctx, bridge, m.slackUserId, dir, { ...m, inChannel: false });
    c.inChannel = false;
    departed.push(c);
  }

  return {
    channel: row.helperChannel,
    memberCount: ids.length,
    truncated,
    maxBatch: row.helperMaxBatch,
    autoProvision: row.helperAutoProvision,
    offboarding: row.helperOffboarding,
    paused: row.helperPausedAt ? { at: row.helperPausedAt.toISOString(), reason: row.helperPausedReason ?? "a burst of joins" } : null,
    serviceToken,
    candidates,
    departed,
  };
}

/** Can this bridge's Chatwoot token add agents at all? Only administrators may. */
async function serviceTokenRole(bridge: Bridge): Promise<{ role: string | null; canProvision: boolean; error?: string }> {
  try {
    const profile = await bridge.chatwoot.whoAmI(bridge.apiToken);
    const role = profile.accounts?.find((a) => a.id === bridge.row.chatwootAccountId)?.role ?? null;
    return { role, canProvision: role === "administrator" };
  } catch (err) {
    return { role: null, canProvision: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- provisioning ----------

/**
 * Provision exactly the people named, and nobody else. The caller has seen each of them on the
 * review screen; this re-resolves every one against Chatwoot anyway, because the review may be
 * minutes old. `allow` is the widest bucket that may be acted on, so an automatic run can be
 * restricted to people Chatwoot already has without a second code path.
 */
export async function provisionHelpers(
  ctx: AppContext,
  bridge: Bridge,
  slackUserIds: string[],
  opts: { actor: string | null; allow?: "existing" | "all" } = { actor: null },
): Promise<ProvisionResult[]> {
  const row = bridge.row;
  const ids = [...new Set(slackUserIds)];
  if (ids.length === 0) return [];
  if (ids.length > row.helperMaxBatch) {
    throw new PermanentError(`that is ${ids.length} people and this bridge's limit is ${row.helperMaxBatch} at a time; raise the limit if you mean it`);
  }
  const allow = opts.allow ?? "all";
  const dir = await directory(bridge);
  const tracked = new Map((await listHelperMembers(ctx.db, row.id)).map((m) => [m.slackUserId, m]));
  const results: ProvisionResult[] = [];

  for (const slackUserId of ids) {
    const c = await resolve(ctx, bridge, slackUserId, dir, tracked.get(slackUserId));
    const common = { slackUserId, bucket: c.bucket };

    if (c.bucket === "blocked") {
      await upsertHelper(ctx.db, row.id, slackUserId, { name: c.name, email: c.email, state: "blocked", lastError: c.reason });
      await note(ctx.db, row.id, "blocked", slackUserId, c.reason, opts.actor);
      results.push({ ...common, ok: false, detail: c.reason });
      continue;
    }
    if (c.bucket === "invite" && allow === "existing") {
      await upsertHelper(ctx.db, row.id, slackUserId, { name: c.name, email: c.email, state: "pending" });
      results.push({ ...common, ok: false, detail: "left for review: Chatwoot has no user for them yet" });
      continue;
    }
    if (c.bucket === "member" && c.chatwootUserId) {
      // Nothing to do in Chatwoot; just record that this bridge knows them.
      await upsertHelper(ctx.db, row.id, slackUserId, {
        name: c.name,
        email: c.email,
        chatwootUserId: c.chatwootUserId,
        state: "provisioned",
        lastError: null,
        provisionedAt: tracked.get(slackUserId)?.provisionedAt ?? new Date(),
      });
      await note(ctx.db, row.id, "provisioned", slackUserId, "already an agent on the account; linked", opts.actor);
      results.push({ ...common, ok: true, detail: "already an agent; linked", chatwootUserId: c.chatwootUserId });
      continue;
    }

    try {
      const agent = await bridge.chatwoot.createAgent({ name: c.name, email: c.email!, role: row.helperChatwootRole }, bridge.apiToken);
      await upsertHelper(ctx.db, row.id, slackUserId, {
        name: c.name,
        email: c.email,
        chatwootUserId: agent.id,
        state: "provisioned",
        lastError: null,
        provisionedAt: new Date(),
        unlinkedAt: null,
      });
      const detail = c.bucket === "existing" ? `added ${c.email} to the account` : `invited ${c.email} as a new Chatwoot user`;
      await note(ctx.db, row.id, "provisioned", slackUserId, detail, opts.actor);
      log.info("helper provisioned", { bridge: row.name, slackUserId, chatwootUserId: agent.id, bucket: c.bucket, by: opts.actor ?? "auto" });
      results.push({ ...common, ok: true, detail, chatwootUserId: agent.id });
    } catch (err) {
      const message = err instanceof ChatwootHttpError ? `Chatwoot ${err.status}: ${err.body.slice(0, 200)}` : err instanceof Error ? err.message : String(err);
      await upsertHelper(ctx.db, row.id, slackUserId, { name: c.name, email: c.email, state: "failed", lastError: message });
      await note(ctx.db, row.id, "failed", slackUserId, message, opts.actor);
      log.warn("could not provision a helper", { bridge: row.name, slackUserId, error: message });
      results.push({ ...common, ok: false, detail: message });
    }
  }
  return results;
}

/**
 * Ask people to link their account instead of guessing an address for them. This is the answer to
 * an unconfirmed helper: a Hack Club account's Chatwoot address is usually not the one on their
 * Slack profile, so inviting the Slack one hands them a second login rather than the account they
 * already use. One direct message, at most once a week per person, and never to somebody who is
 * already provisioned, already confirmed, or deliberately skipped.
 */
export async function askHelpersToLink(
  ctx: AppContext,
  bridge: Bridge,
  slackUserIds: string[],
  opts: { actor: string | null; now?: Date } = { actor: null },
): Promise<AskResult[]> {
  const row = bridge.row;
  const text = row.helperLinkPrompt?.trim();
  if (!text) return slackUserIds.map((slackUserId) => ({ slackUserId, ok: false, detail: "this bridge has no link message configured" }));
  const now = opts.now ?? new Date();
  const ids = [...new Set(slackUserIds)];
  if (ids.length > row.helperMaxBatch) {
    throw new PermanentError(`that is ${ids.length} people and this bridge's limit is ${row.helperMaxBatch} at a time; raise the limit if you mean it`);
  }
  const dir = await directory(bridge);
  const tracked = new Map((await listHelperMembers(ctx.db, row.id)).map((m) => [m.slackUserId, m]));
  const body = text.replaceAll("{link}", `${ctx.config.PUBLIC_URL}/link`).replaceAll("{channel}", row.helperChannel ?? "");
  const out: AskResult[] = [];

  for (const slackUserId of ids) {
    const existing = tracked.get(slackUserId);
    if (existing?.state === "skipped") {
      out.push({ slackUserId, ok: false, detail: "skipped by a human" });
      continue;
    }
    if (existing?.state === "provisioned") {
      out.push({ slackUserId, ok: false, detail: "already provisioned" });
      continue;
    }
    if (existing?.linkAskedAt && now.getTime() - existing.linkAskedAt.getTime() < HELPER_LINK_ASK_COOLDOWN_MS) {
      out.push({ slackUserId, ok: false, detail: `already asked on ${existing.linkAskedAt.toISOString().slice(0, 10)}` });
      continue;
    }
    const c = await resolve(ctx, bridge, slackUserId, dir, existing);
    if (isConfirmed(c)) {
      out.push({ slackUserId, ok: false, detail: "nothing to ask: Chatwoot already knows them" });
      continue;
    }
    if (c.bucket === "blocked" && c.reason.includes("bot")) {
      out.push({ slackUserId, ok: false, detail: "a bot, not a person" });
      continue;
    }
    try {
      await postDirectMessage(bridge, slackUserId, body);
      await upsertHelper(ctx.db, row.id, slackUserId, { name: c.name, email: c.email, linkAskedAt: now });
      await note(ctx.db, row.id, "asked", slackUserId, "asked them to link their account", opts.actor);
      out.push({ slackUserId, ok: true, detail: "asked them to link" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("could not ask a helper to link", { bridge: row.name, slackUserId, error: message });
      out.push({ slackUserId, ok: false, detail: message });
    }
  }
  return out;
}

/**
 * Somebody just linked their Slack account. If that made them recognisable to Chatwoot, finish
 * the job on every helper channel they are sitting in — this is what closes the loop between
 * "we asked you to link" and them actually having an account.
 *
 * Never invites: this path only provisions people Chatwoot now has a user for, which is the whole
 * point of having waited for them to link.
 */
export async function provisionLinkedHelper(ctx: AppContext, slackUserId: string): Promise<void> {
  for (const bridge of ctx.bridges.all()) {
    const row = bridge.row;
    if (!row.helperChannel || row.helperPausedAt) continue;
    const tracked = await findHelperMember(ctx.db, row.id, slackUserId);
    if (!tracked?.inChannel) continue;
    // A bridge that provisions nobody automatically still finishes off somebody it asked: being
    // sent the link *is* the decision, and leaving them to wait for a second human is how people
    // end up linked and still unable to answer anything.
    if (row.helperAutoProvision === "off" && !tracked.linkAskedAt) continue;
    if (tracked.state !== "pending" && tracked.state !== "blocked" && tracked.state !== "failed") continue;
    try {
      const [result] = await provisionHelpers(ctx, bridge, [slackUserId], { actor: null, allow: "existing" });
      if (result?.ok) log.info("provisioned a helper as soon as they linked", { bridge: row.name, slackUserId });
    } catch (err) {
      log.warn("could not provision a helper after they linked", { bridge: row.name, slackUserId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Take somebody off this bridge's Chatwoot account. Their Chatwoot user, its login and
 * everything they wrote stay exactly where they are — this bridge has no code path that deletes
 * a Chatwoot account, and the tracked row is kept so a later rejoin finds the same user again.
 */
export async function unlinkHelper(ctx: AppContext, bridge: Bridge, slackUserId: string, actor: string | null): Promise<string> {
  const row = bridge.row;
  const tracked = await findHelperMember(ctx.db, row.id, slackUserId);
  if (!tracked?.chatwootUserId) {
    await upsertHelper(ctx.db, row.id, slackUserId, { state: "unlinked", unlinkedAt: new Date() });
    return "nothing to remove in Chatwoot";
  }
  try {
    await bridge.chatwoot.removeAgentFromAccount(tracked.chatwootUserId, bridge.apiToken);
  } catch (err) {
    // A 404 means they are already off the account, which is the state we wanted anyway.
    if (!(err instanceof ChatwootHttpError && err.status === 404)) {
      const message = err instanceof ChatwootHttpError ? `Chatwoot ${err.status}: ${err.body.slice(0, 200)}` : err instanceof Error ? err.message : String(err);
      await upsertHelper(ctx.db, row.id, slackUserId, { state: "failed", lastError: message });
      await note(ctx.db, row.id, "failed", slackUserId, `could not unlink: ${message}`, actor);
      throw err;
    }
  }
  await upsertHelper(ctx.db, row.id, slackUserId, { state: "unlinked", unlinkedAt: new Date(), lastError: null });
  await note(ctx.db, row.id, "unlinked", slackUserId, "removed from the Chatwoot account; their Chatwoot user was kept", actor);
  log.info("helper unlinked from chatwoot account", { bridge: row.name, slackUserId, chatwootUserId: tracked.chatwootUserId, by: actor ?? "auto" });
  return "removed from the Chatwoot account; their Chatwoot user was kept";
}

/** Mark somebody as deliberately not provisioned, so automatic runs leave them alone. */
export async function skipHelper(ctx: AppContext, bridgeId: number, slackUserId: string, actor: string | null): Promise<void> {
  await upsertHelper(ctx.db, bridgeId, slackUserId, { state: "skipped", lastError: null });
  await note(ctx.db, bridgeId, "skipped", slackUserId, "a human said not to provision them", actor);
}

/** Undo a skip or a failure so the person is offered again. */
export async function unskipHelper(ctx: AppContext, bridgeId: number, slackUserId: string, actor: string | null): Promise<void> {
  await upsertHelper(ctx.db, bridgeId, slackUserId, { state: "pending", lastError: null });
  await note(ctx.db, bridgeId, "resumed", slackUserId, "put back up for review", actor);
}

// ---------- joins and departures ----------

/** How many people joined this helper channel in the last window. */
async function recentJoins(db: Db, bridgeId: number, since: Date): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(helperEvents)
    .where(and(eq(helperEvents.bridgeId, bridgeId), eq(helperEvents.action, "joined"), gte(helperEvents.createdAt, since)));
  return rows[0]?.n ?? 0;
}

export async function pauseHelperAutoProvision(ctx: AppContext, bridgeId: number, reason: string): Promise<void> {
  await ctx.db.update(bridges).set({ helperPausedAt: new Date(), helperPausedReason: reason }).where(eq(bridges.id, bridgeId));
  await note(ctx.db, bridgeId, "paused", null, reason, null);
  await ctx.bridges.reload();
  log.warn("paused helper auto-provisioning", { bridgeId, reason });
}

export async function resumeHelperAutoProvision(ctx: AppContext, bridgeId: number, actor: string | null): Promise<void> {
  await ctx.db.update(bridges).set({ helperPausedAt: null, helperPausedReason: null }).where(eq(bridges.id, bridgeId));
  await note(ctx.db, bridgeId, "resumed", null, "auto-provisioning switched back on", actor);
  await ctx.bridges.reload();
}

/**
 * Somebody joined a helper channel. The join is always recorded; whether it provisions anybody
 * depends on the bridge's setting, and a burst of joins turns provisioning off rather than
 * running it — the failure mode we are protecting against is one `/invite` of fifty people
 * turning into fifty Chatwoot invitations.
 */
export async function recordHelperJoin(ctx: AppContext, job: HelperJoinedJob): Promise<void> {
  const bridge = ctx.bridges.get(job.bridgeId);
  if (!bridge?.row.helperChannel) return;
  const row = bridge.row;
  const existing = await findHelperMember(ctx.db, row.id, job.slackUserId);
  await upsertHelper(ctx.db, row.id, job.slackUserId, {
    inChannel: true,
    joinedAt: new Date(),
    leftAt: null,
    // Coming back puts an unlinked person up for review again; a deliberate skip stands.
    ...(existing?.state === "unlinked" || existing?.state === "failed" ? { state: "pending" as const } : {}),
  });
  await note(ctx.db, row.id, "joined", job.slackUserId, "joined the helper channel", null);

  if (row.helperAutoProvision === "off") return;
  if (row.helperPausedAt) {
    log.info("helper join left pending; auto-provisioning is paused", { bridge: row.name, slackUserId: job.slackUserId });
    return;
  }
  if (existing?.state === "skipped") return;

  const joins = await recentJoins(ctx.db, row.id, new Date(Date.now() - HELPER_BURST_WINDOW_MS));
  if (joins > row.helperMaxBatch) {
    await pauseHelperAutoProvision(
      ctx,
      row.id,
      `${joins} people joined ${row.helperChannel} in ten minutes, over this bridge's limit of ${row.helperMaxBatch}. Nobody was provisioned; review the roster and resume.`,
    );
    return;
  }
  const [result] = await provisionHelpers(ctx, bridge, [job.slackUserId], {
    actor: null,
    allow: row.helperAutoProvision === "all" ? "all" : "existing",
  });
  // Not provisioned because we cannot confirm who they are in Chatwoot? Ask, rather than guess.
  if (!result?.ok && result?.bucket !== "member") {
    await askHelpersToLink(ctx, bridge, [job.slackUserId], { actor: null });
  }
}

/** Somebody left a helper channel. Recorded always; unlinked from Chatwoot only if configured. */
export async function recordHelperLeave(ctx: AppContext, job: HelperLeftJob): Promise<void> {
  const bridge = ctx.bridges.get(job.bridgeId);
  if (!bridge?.row.helperChannel) return;
  const row = bridge.row;
  const existing = await findHelperMember(ctx.db, row.id, job.slackUserId);
  await upsertHelper(ctx.db, row.id, job.slackUserId, { inChannel: false, leftAt: new Date() });
  await note(ctx.db, row.id, "left", job.slackUserId, "left the helper channel", null);
  if (row.helperOffboarding !== "unlink") return;
  if (existing?.state !== "provisioned") return;
  await unlinkHelper(ctx, bridge, job.slackUserId, null);
}

export function registerHelperJobs(ctx: AppContext): void {
  ctx.retry.register(JOB_HELPER_JOINED, (payload) => recordHelperJoin(ctx, payload as HelperJoinedJob));
  ctx.retry.register(JOB_HELPER_LEFT, (payload) => recordHelperLeave(ctx, payload as HelperLeftJob));
}
