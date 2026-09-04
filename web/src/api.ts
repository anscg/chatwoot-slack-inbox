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

export type GlobalRole = "superadmin" | "admin" | "operator";
export type BridgeRole = "admin" | "operator";

export interface Me {
  user: { userId: string; name: string; role: GlobalRole };
  can: { createBridge: boolean; managePeople: boolean; seeOps: boolean };
  chatwootBaseUrl: string;
  publicUrl: string;
  defaults: { welcomeMessage: string; resolvedEmoji: string; resolveButtonLabel: string; reopenButtonLabel: string; resolveMessage: string; reopenMessage: string; reopenPromptMessage: string; followupPromptMessage: string; linkPromptMessage: string };
}
export interface Status {
  /** Superadmins only: it embeds the install-wide Chatwoot webhook secret. */
  webhookUrl?: string;
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
  resolvedEmoji: string | null;
  welcomeMessage: string | null;
  resolveButtonLabel: string | null;
  reopenButtonLabel: string | null;
  resolveMessage: string | null;
  reopenMessage: string | null;
  reopenPromptMessage: string | null;
  followupPromptMessage: string | null;
  requireLink: boolean;
  linkPromptMessage: string | null;
  enabled: boolean;
  hasChatwootToken: boolean;
  createdAt: string;
  updatedAt: string;
  warning?: string;
  /** The signed-in person's role on this bridge; superadmins read as "admin". */
  yourRole: BridgeRole | null;
}

export interface BridgeMember {
  slackUserId: string;
  name: string | null;
  role: BridgeRole;
  invitedBy: string | null;
  createdAt: string;
}
export interface BridgeMembers {
  canInvite: boolean;
  members: BridgeMember[];
  superadmins: { slackUserId: string; name: string | null }[];
}
export interface Person {
  slackUserId: string;
  name: string | null;
  role: GlobalRole;
  invitedBy: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  bridges: { id: number; name: string | null; role: BridgeRole }[];
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
export interface BridgeCheck {
  name: string;
  enabled: boolean;
  loaded: boolean;
  eventsUrl: string;
  threads: number;
  behaviour: {
    reactionResolve: string | null;
    reactionAssign: string | null;
    resolvedEmoji: string | null;
    resolveButtonLabel: string | null;
    reopenButtonLabel: string | null;
    welcomeMessage: boolean;
    resolveMessage: boolean;
    reopenMessage: boolean;
    reopenPromptMessage: boolean;
    followupPromptMessage: boolean;
    requireLink: boolean;
    linkPromptMessage: boolean;
  };
  slack?: {
    bot?: string;
    team?: string;
    scopes?: string[];
    missingScopes?: string[];
    channel?: { id: string; name?: string; isMember?: boolean; error?: string };
    error?: string;
  };
  chatwoot?: { ok?: boolean; accountId?: number; agents?: number; error?: string };
  traffic: { at: string; kind: string; detail: string }[];
}
export interface SlackIntrospection {
  bot: { userId?: string; botId?: string; name?: string; team?: string };
  channel?: { id: string; name?: string; isMember: boolean; error?: string };
}
export interface Introspection {
  profile: { id: number; name: string; email: string };
  accounts: { id: number; name: string; role?: string; inboxes: { id: number; name: string; inboxIdentifier?: string }[] }[];
}
