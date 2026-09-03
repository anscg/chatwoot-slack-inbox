export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers: { "x-requested-with": "fetch", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => call<T>("PUT", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};

export interface Me {
  user: { userId: string; name: string };
  chatwootBaseUrl: string;
  publicUrl: string;
  defaults: { welcomeMessage: string; resolveMessage: string; reopenMessage: string };
}
export interface Status {
  webhookUrl: string;
  linkUrl: string;
  counts: { threads: number; relayed: number; agents: number; retries: number };
}
export interface Bridge {
  id: number;
  name: string;
  slug: string;
  slackChannel: string;
  slackBotId: string | null;
  slackBotUserId: string | null;
  slackTeamId: string | null;
  hasSlackApp: boolean;
  eventsUrl: string;
  chatwootAccountId: number;
  chatwootInboxIdentifier: string;
  reactionResolve: string | null;
  reactionAssign: string | null;
  welcomeMessage: string | null;
  resolveMessage: string | null;
  reopenMessage: string | null;
  enabled: boolean;
  hasChatwootToken: boolean;
  createdAt: string;
  updatedAt: string;
  warning?: string;
}
export interface Agent {
  id: number;
  slackUserId: string;
  chatwootAgentId: number | null;
  email: string | null;
  hasSlackToken: boolean;
  hasChatwootToken: boolean;
  createdAt: string;
}
export interface ChatwootAgentSummary {
  id: number;
  name: string;
  email: string | null;
  accounts: number[];
}
export interface Thread {
  id: number;
  slackChannel: string;
  slackThreadTs: string;
  chatwootAccountId: number;
  chatwootConversationId: number;
  slackAuthorId: string;
  createdAt: string;
  bridge: string | null;
}
export interface Retry {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
}
export interface SlackIntrospection {
  bot: { userId?: string; botId?: string; name?: string; team?: string };
  channel?: { id: string; name?: string; isMember: boolean; error?: string };
}
export interface Introspection {
  profile: { id: number; name: string; email: string };
  accounts: { id: number; name: string; role?: string; inboxes: { id: number; name: string; inboxIdentifier?: string }[] }[];
}
