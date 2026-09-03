import type { WebClient } from "@slack/web-api";

export interface SlackProfile {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  isBot: boolean;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; profile: SlackProfile }>();

export async function getSlackProfile(slack: WebClient, userId: string): Promise<SlackProfile> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  const res = await slack.users.info({ user: userId });
  const u = res.user;
  const profile: SlackProfile = {
    id: userId,
    name: u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name || userId,
    email: u?.profile?.email ?? undefined,
    avatarUrl: u?.profile?.image_192 ?? u?.profile?.image_72 ?? undefined,
    isBot: Boolean(u?.is_bot),
  };
  cache.set(userId, { at: Date.now(), profile });
  return profile;
}

/**
 * Does this message still exist? Called before posting a welcome into a brand new thread, because a
 * question deleted seconds after being asked would otherwise get a reply posted to the channel.
 * Errors count as "still there": the postThreaded guard is the backstop.
 */
export async function messageStillExists(slack: WebClient, channel: string, ts: string): Promise<boolean> {
  try {
    const res = await slack.conversations.history({ channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
    return (res.messages ?? []).some((m) => (m as { ts?: string }).ts === ts);
  } catch {
    return true;
  }
}

export function clearProfileCache(): void {
  cache.clear();
}
