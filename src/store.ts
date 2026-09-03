import { and, eq, lt } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { agents, relayed, seenEvents, threads, type Agent, type Thread } from "./db/schema.js";

export const SEEN_EVENT_TTL_MS = 24 * 60 * 60_000;

/** Returns true if this is the first time we've seen `eventId`. */
export async function markEventSeen(db: Db, eventId: string): Promise<boolean> {
  const rows = await db.insert(seenEvents).values({ eventId }).onConflictDoNothing().returning({ eventId: seenEvents.eventId });
  return rows.length > 0;
}

export async function pruneSeenEvents(db: Db, now = new Date()): Promise<void> {
  await db.delete(seenEvents).where(lt(seenEvents.seenAt, new Date(now.getTime() - SEEN_EVENT_TTL_MS)));
}

export async function isRelayedSlack(db: Db, channel: string, ts: string): Promise<boolean> {
  const rows = await db
    .select({ id: relayed.id })
    .from(relayed)
    .where(and(eq(relayed.slackChannel, channel), eq(relayed.slackTs, ts)))
    .limit(1);
  return rows.length > 0;
}

export async function isRelayedChatwoot(db: Db, chatwootMessageId: number): Promise<boolean> {
  const rows = await db.select({ id: relayed.id }).from(relayed).where(eq(relayed.chatwootMessageId, chatwootMessageId)).limit(1);
  return rows.length > 0;
}

export async function recordRelayed(
  db: Db,
  row: { slackChannel: string; slackTs: string; chatwootMessageId: number; direction: "slack_to_chatwoot" | "chatwoot_to_slack" },
): Promise<void> {
  await db.insert(relayed).values(row).onConflictDoNothing();
}

export async function findThreadBySlack(db: Db, channel: string, threadTs: string): Promise<Thread | undefined> {
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.slackChannel, channel), eq(threads.slackThreadTs, threadTs)))
    .limit(1);
  return rows[0];
}

export async function findThreadByConversation(db: Db, accountId: number, conversationId: number): Promise<Thread | undefined> {
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.chatwootAccountId, accountId), eq(threads.chatwootConversationId, conversationId)))
    .limit(1);
  return rows[0];
}

export async function insertThread(db: Db, row: typeof threads.$inferInsert): Promise<Thread> {
  const inserted = await db.insert(threads).values(row).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  // Lost a race; the row now exists.
  const existing = await findThreadBySlack(db, row.slackChannel, row.slackThreadTs);
  if (!existing) throw new Error("thread insert conflicted but row not found");
  return existing;
}

export async function findAgentBySlackUser(db: Db, slackUserId: string): Promise<Agent | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.slackUserId, slackUserId)).limit(1);
  return rows[0];
}

export async function findAgentByChatwootId(db: Db, chatwootAgentId: number): Promise<Agent | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.chatwootAgentId, chatwootAgentId)).limit(1);
  return rows[0];
}

export async function upsertAgent(db: Db, row: typeof agents.$inferInsert): Promise<Agent> {
  const { slackUserId, ...rest } = row;
  const set: Partial<typeof agents.$inferInsert> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  const rows = await db
    .insert(agents)
    .values(row)
    .onConflictDoUpdate({ target: agents.slackUserId, set: Object.keys(set).length ? set : { slackUserId } })
    .returning();
  const out = rows[0];
  if (!out) throw new Error("agent upsert returned no row");
  return out;
}
