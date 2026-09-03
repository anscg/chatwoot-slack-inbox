/**
 * A small in-memory ring of the Slack traffic each bridge has received, surfaced in the panel's
 * per-bridge Check. Deliberately not persisted: its whole job is answering "is Slack actually
 * sending us this event?" while a bridge is being set up. Cleared on restart.
 */
export interface TrafficEntry {
  at: string;
  kind: string;
  detail: string;
}

const MAX_PER_BRIDGE = 30;
const rings = new Map<number, TrafficEntry[]>();

export function recordTraffic(bridgeId: number, kind: string, detail = ""): void {
  const ring = rings.get(bridgeId) ?? [];
  ring.unshift({ at: new Date().toISOString(), kind, detail });
  if (ring.length > MAX_PER_BRIDGE) ring.length = MAX_PER_BRIDGE;
  rings.set(bridgeId, ring);
}

export function recentTraffic(bridgeId: number): TrafficEntry[] {
  return rings.get(bridgeId) ?? [];
}

interface SlackRequestBody {
  type?: string;
  event?: {
    type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    ts?: string;
    deleted_ts?: string;
    reaction?: string;
    item?: { ts?: string; channel?: string };
  };
  actions?: { action_id?: string; value?: string }[];
  user?: { id?: string };
}

/** One-line summary of an inbound Slack request, for the traffic ring. */
export function describeSlackRequest(body: unknown): { kind: string; detail: string } {
  const b = (body ?? {}) as SlackRequestBody;
  if (b.type === "event_callback" && b.event) {
    const e = b.event;
    if (e.type === "reaction_added" || e.type === "reaction_removed") {
      return { kind: `event:${e.type}`, detail: `:${e.reaction}: by ${e.user ?? "?"} on message ${e.item?.ts ?? "?"}` };
    }
    if (e.type === "message") {
      // A deletion carries the removed message's ts separately, and that is the interesting one.
      if (e.subtype === "message_deleted") return { kind: "event:message_deleted", detail: `deleted message ${e.deleted_ts ?? "?"}` };
      return { kind: "event:message", detail: `${e.subtype ?? "plain"} from ${e.user ?? e.bot_id ?? "?"} at ${e.ts ?? "?"}` };
    }
    return { kind: `event:${e.type ?? "unknown"}`, detail: "" };
  }
  if (b.type === "block_actions") {
    return { kind: "interactive:block_actions", detail: `${b.actions?.[0]?.action_id ?? "?"} by ${b.user?.id ?? "?"}` };
  }
  return { kind: b.type ?? "unknown", detail: "" };
}
