import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { agents, heldMessages, relayed, relayedFiles, seenEvents, threads, type Agent, type HeldMessage, type Relayed, type Thread } from "./db/schema.js";

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

export async function recordRelayedFiles(db: Db, slackFileIds: string[], chatwootMessageId: number): Promise<void> {
  if (slackFileIds.length === 0) return;
  await db
    .insert(relayedFiles)
    .values(slackFileIds.map((slackFileId) => ({ slackFileId, chatwootMessageId })))
    .onConflictDoNothing();
}

/** True when every file id given was uploaded by the bridge (i.e. the message is our own echo). */
export async function allFilesRelayed(db: Db, slackFileIds: string[]): Promise<boolean> {
  if (slackFileIds.length === 0) return false;
  const rows = await db.select({ id: relayedFiles.slackFileId }).from(relayedFiles).where(inArray(relayedFiles.slackFileId, slackFileIds));
  return rows.length === slackFileIds.length;
}

export async function isRelayedChatwoot(db: Db, chatwootMessageId: number): Promise<boolean> {
  const rows = await db.select({ id: relayed.id }).from(relayed).where(eq(relayed.chatwootMessageId, chatwootMessageId)).limit(1);
  return rows.length > 0;
}

/** The relay record for one Slack message, either direction, or undefined if we never relayed it. */
export async function findRelayedBySlack(db: Db, channel: string, ts: string): Promise<Relayed | undefined> {
  const rows = await db
    .select()
    .from(relayed)
    .where(and(eq(relayed.slackChannel, channel), eq(relayed.slackTs, ts)))
    .limit(1);
  return rows[0];
}

export async function findRelayedByChatwoot(db: Db, chatwootMessageId: number): Promise<Relayed | undefined> {
  const rows = await db.select().from(relayed).where(eq(relayed.chatwootMessageId, chatwootMessageId)).limit(1);
  return rows[0];
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

/**
 * Has this Slack user been through /link? The row alone is not enough: an admin can pre-create one
 * to attach a Chatwoot token, so it is the stored Slack user token that says they authorized us.
 */
export async function hasLinkedSlackAccount(db: Db, slackUserId: string): Promise<boolean> {
  const rows = await db
    .select({ token: agents.slackUserTokenEnc })
    .from(agents)
    .where(eq(agents.slackUserId, slackUserId))
    .limit(1);
  return Boolean(rows[0]?.token);
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

export async function setAgentChatwootToken(db: Db, agentRowId: number, tokenEnc: string): Promise<void> {
  await db.update(agents).set({ chatwootApiTokenEnc: tokenEnc }).where(eq(agents.id, agentRowId));
}

export async function markThreadDeleted(db: Db, threadId: number): Promise<void> {
  await db.update(threads).set({ deletedAt: new Date() }).where(eq(threads.id, threadId));
}

export async function setWelcomeMessageTs(db: Db, threadId: number, ts: string): Promise<void> {
  await db.update(threads).set({ welcomeMessageTs: ts }).where(eq(threads.id, threadId));
}

export async function setThreadStatus(db: Db, threadId: number, patch: { lastStatus: string; statusMessageTs: string | null }): Promise<void> {
  await db.update(threads).set(patch).where(eq(threads.id, threadId));
}

/** Mark the thread as waiting for an answer to the reopen prompt. Returns the token to match on. */
export async function setReopenPrompt(db: Db, threadId: number, user: string, at = new Date()): Promise<Date> {
  await db.update(threads).set({ reopenPromptAt: at, reopenPromptUser: user }).where(eq(threads.id, threadId));
  return at;
}

/** The prompt has been answered, superseded, or overtaken by a helper; stop the pending timeout. */
export async function clearReopenPrompt(db: Db, threadId: number): Promise<void> {
  await db.update(threads).set({ reopenPromptAt: null, reopenPromptUser: null }).where(eq(threads.id, threadId));
}

/** Their most recent live question in this channel, if they asked one since `since`. */
export async function findRecentThreadByAuthor(db: Db, channel: string, slackUserId: string, since: Date): Promise<Thread | undefined> {
  const rows = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.slackChannel, channel),
        eq(threads.slackAuthorId, slackUserId),
        isNull(threads.deletedAt),
        gte(threads.createdAt, since),
      ),
    )
    .orderBy(desc(threads.createdAt))
    .limit(1);
  return rows[0];
}

/** Park a relay job until its sender says whether the message is a new question. */
export async function holdMessage(db: Db, row: typeof heldMessages.$inferInsert): Promise<HeldMessage | undefined> {
  const rows = await db.insert(heldMessages).values(row).onConflictDoNothing().returning();
  return rows[0];
}

export async function findHeldMessage(db: Db, channel: string, ts: string): Promise<HeldMessage | undefined> {
  const rows = await db
    .select()
    .from(heldMessages)
    .where(and(eq(heldMessages.slackChannel, channel), eq(heldMessages.slackTs, ts)))
    .limit(1);
  return rows[0];
}

/**
 * Record the answer to a hold, but only the first one: a click and the timeout can race, and
 * whichever lands first decides. Returns the row when this call is the one that answered it.
 */
export async function answerHeldMessage(db: Db, id: number, answer: "separate" | "related" | "timeout"): Promise<HeldMessage | undefined> {
  const rows = await db
    .update(heldMessages)
    .set({ answer, answeredAt: new Date() })
    .where(and(eq(heldMessages.id, id), isNull(heldMessages.answeredAt)))
    .returning();
  return rows[0];
}
