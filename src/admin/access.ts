import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { adminUsers, bridgeMembers } from "../db/schema.js";
import { log } from "../logger.js";

/** How far someone reaches on their own, before any per-bridge grant. */
export type GlobalRole = "superadmin" | "admin" | "operator";
/** What someone may do on one bridge. */
export type BridgeRole = "admin" | "operator";

/**
 * A signed-in person, resolved fresh on every request so a revoked role takes effect
 * immediately rather than at the end of a 12-hour session.
 */
export interface Actor {
  slackUserId: string;
  name: string;
  role: GlobalRole;
  /** Per-bridge grants. Empty for a superadmin, who is an admin of every bridge implicitly. */
  bridges: Map<number, BridgeRole>;
}

export const isSuper = (a: Actor): boolean => a.role === "superadmin";

/** Only superadmins and admins may stand up a new bridge; the creator becomes its admin. */
export const canCreateBridge = (a: Actor): boolean => a.role === "superadmin" || a.role === "admin";

/** What this person may do on one bridge, or undefined if the bridge is not theirs to see. */
export function bridgeRole(a: Actor, bridgeId: number): BridgeRole | undefined {
  if (isSuper(a)) return "admin";
  return a.bridges.get(bridgeId);
}

/** Configure the bridge: settings, credentials, channel. Operators included. */
export const canConfigureBridge = (a: Actor, bridgeId: number): boolean => bridgeRole(a, bridgeId) !== undefined;

/** Invite or remove members, and delete the bridge. Its admins only, never its operators. */
export const canAdministerBridge = (a: Actor, bridgeId: number): boolean => bridgeRole(a, bridgeId) === "admin";

/** Bridge ids this person may see, or `null` meaning "all of them" (superadmin). */
export function visibleBridgeIds(a: Actor): number[] | null {
  return isSuper(a) ? null : [...a.bridges.keys()];
}

/** Load the roster row and per-bridge grants, or null if this Slack user may not sign in at all. */
export async function loadActor(db: Db, slackUserId: string): Promise<Actor | null> {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.slackUserId, slackUserId));
  if (!row) return null;
  const members = await db.select().from(bridgeMembers).where(eq(bridgeMembers.slackUserId, slackUserId));
  return {
    slackUserId,
    name: row.name ?? slackUserId,
    role: row.role,
    bridges: new Map(members.map((m) => [m.bridgeId, m.role])),
  };
}

/**
 * Bootstrap the roster. ADMIN_SLACK_USER_IDS only matters while no superadmin exists: on a
 * fresh install it names the first ones, and after that the panel is the source of truth, so
 * demoting someone in the panel is not undone by the next restart. Returns how many were added.
 */
export async function seedSuperadmins(db: Db, slackUserIds: string[]): Promise<number> {
  const existing = await db.select().from(adminUsers).where(eq(adminUsers.role, "superadmin"));
  if (existing.length > 0) return 0;
  let added = 0;
  for (const slackUserId of slackUserIds) {
    await db
      .insert(adminUsers)
      .values({ slackUserId, role: "superadmin" })
      .onConflictDoUpdate({ target: adminUsers.slackUserId, set: { role: "superadmin" } });
    added += 1;
  }
  if (added > 0) log.info("seeded superadmins from ADMIN_SLACK_USER_IDS", { slackUserIds });
  return added;
}

/** Names for a set of Slack user IDs, best-effort from the roster we already hold. */
export async function rosterNames(db: Db, slackUserIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(slackUserIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(adminUsers).where(inArray(adminUsers.slackUserId, ids));
  return new Map(rows.filter((r) => r.name).map((r) => [r.slackUserId, r.name!]));
}
