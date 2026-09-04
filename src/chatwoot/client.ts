import { log } from "../logger.js";

export class ChatwootHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`Chatwoot ${status} ${url}: ${body.slice(0, 300)}`);
    this.name = "ChatwootHttpError";
  }
  /** 4xx (except 429) will not succeed on retry. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface ChatwootAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface PublicContact {
  id: number;
  source_id: string;
  name?: string;
  email?: string | null;
  pubsub_token?: string;
}

export interface PublicConversation {
  id: number;
  inbox_id: number;
  contact_last_seen_at?: number;
  status?: string;
}

export interface ChatwootMessage {
  id: number;
  content: string | null;
  message_type: number | string;
  conversation_id: number;
  private?: boolean;
  sender?: { id: number; name?: string; email?: string; avatar_url?: string; type?: string } | null;
}

export interface ChatwootAgent {
  id: number;
  name: string;
  email: string;
  avatar_url?: string;
  role?: string;
}

export interface ChatwootProfile extends ChatwootAgent {
  accounts?: { id: number; name: string; role?: string }[];
}

export interface ChatwootInbox {
  id: number;
  name: string;
  channel_type: string;
  inbox_identifier?: string;
}

export interface UpsertContactInput {
  identifier: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface ChatwootClientOptions {
  baseUrl: string;
  accountId: number;
  inboxIdentifier: string;
  /** Service-agent token, used for Application API calls when no per-agent token is given. */
  apiToken: string;
  fetchFn?: typeof fetch;
}

/**
 * Thin typed wrapper over the two Chatwoot APIs we need:
 *  - Public (client) API: acts as the *contact*. No auth; scoped by inbox identifier.
 *  - Application API: acts as an *agent*. Auth via `api_access_token` header.
 */
export class ChatwootClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ChatwootClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  // ---------- Public API (as contact) ----------

  private get publicBase(): string {
    return `${this.opts.baseUrl}/public/api/v1/inboxes/${encodeURIComponent(this.opts.inboxIdentifier)}`;
  }

  /** Create-or-update a contact keyed by `identifier`. Returns the contact incl. `source_id`. */
  async upsertContact(input: UpsertContactInput): Promise<PublicContact> {
    const body: Record<string, unknown> = { identifier: input.identifier, name: input.name };
    if (input.email) body.email = input.email;
    if (input.avatarUrl) body.avatar_url = input.avatarUrl;
    return this.json<PublicContact>("POST", `${this.publicBase}/contacts`, { body });
  }

  async createConversation(sourceId: string): Promise<PublicConversation> {
    return this.json<PublicConversation>("POST", `${this.publicBase}/contacts/${encodeURIComponent(sourceId)}/conversations`, {
      body: {},
    });
  }

  /** Post a message into a conversation as the contact (incoming message). */
  async createContactMessage(
    sourceId: string,
    conversationId: number,
    content: string,
    attachments: ChatwootAttachment[] = [],
    echoId?: string,
  ): Promise<ChatwootMessage> {
    const url = `${this.publicBase}/contacts/${encodeURIComponent(sourceId)}/conversations/${conversationId}/messages`;
    if (attachments.length === 0) {
      return this.json<ChatwootMessage>("POST", url, { body: { content, echo_id: echoId } });
    }
    const form = new FormData();
    form.set("content", content);
    if (echoId) form.set("echo_id", echoId);
    for (const a of attachments) form.append("attachments[]", new Blob([a.data], { type: a.contentType }), a.filename);
    return this.json<ChatwootMessage>("POST", url, { form });
  }

  /**
   * Refresh a contact's name/avatar (Application API). Chatwoot downloads `avatar_url` in a
   * background job; because this runs after contact creation it also beats the Gravatar
   * lookup Chatwoot starts for contacts that have an email.
   */
  async updateContact(contactId: number, input: { name?: string; avatarUrl?: string }, apiToken?: string): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.name) body.name = input.name;
    if (input.avatarUrl) body.avatar_url = input.avatarUrl;
    if (Object.keys(body).length === 0) return;
    await this.json<unknown>("PATCH", `${this.appBase}/contacts/${contactId}`, { token: apiToken ?? this.opts.apiToken, body });
  }

  /** All conversations for a contact in this inbox (public API), incl. `status`. */
  async listContactConversations(sourceId: string): Promise<PublicConversation[]> {
    return this.json<PublicConversation[]>("GET", `${this.publicBase}/contacts/${encodeURIComponent(sourceId)}/conversations`);
  }

  /** Contact-side resolve/reopen toggle (flips open <-> resolved; no explicit status). */
  async toggleStatusAsContact(sourceId: string, conversationId: number): Promise<void> {
    await this.json("POST", `${this.publicBase}/contacts/${encodeURIComponent(sourceId)}/conversations/${conversationId}/toggle_status`, {
      body: {},
    });
  }

  // ---------- Application API (as agent) ----------

  private get appBase(): string {
    return `${this.opts.baseUrl}/api/v1/accounts/${this.opts.accountId}`;
  }

  /** Post an outgoing (agent) message. `apiToken` selects which agent it is attributed to. */
  async createAgentMessage(
    conversationId: number,
    content: string,
    opts: { apiToken?: string; attachments?: ChatwootAttachment[]; private?: boolean } = {},
  ): Promise<ChatwootMessage> {
    const url = `${this.appBase}/conversations/${conversationId}/messages`;
    const token = opts.apiToken ?? this.opts.apiToken;
    const attachments = opts.attachments ?? [];
    if (attachments.length === 0) {
      return this.json<ChatwootMessage>("POST", url, {
        token,
        body: { content, message_type: "outgoing", private: opts.private ?? false },
      });
    }
    const form = new FormData();
    form.set("content", content);
    form.set("message_type", "outgoing");
    form.set("private", String(opts.private ?? false));
    for (const a of attachments) form.append("attachments[]", new Blob([a.data], { type: a.contentType }), a.filename);
    return this.json<ChatwootMessage>("POST", url, { token, form });
  }

  /** Delete a message; Chatwoot soft-deletes it and shows "This message was deleted". */
  async deleteMessage(conversationId: number, messageId: number, apiToken?: string): Promise<void> {
    await this.json("DELETE", `${this.appBase}/conversations/${conversationId}/messages/${messageId}`, { token: apiToken ?? this.opts.apiToken });
  }

  /** The conversation's most recent messages, newest last. */
  async listMessages(conversationId: number, apiToken?: string): Promise<ChatwootMessage[]> {
    const res = await this.json<{ payload?: ChatwootMessage[] } | ChatwootMessage[]>("GET", `${this.appBase}/conversations/${conversationId}/messages`, {
      token: apiToken ?? this.opts.apiToken,
    });
    return Array.isArray(res) ? res : (res.payload ?? []);
  }

  /** Rewrite a message's text in place, as Chatwoot's own edit-message feature does. */
  async updateMessageContent(conversationId: number, messageId: number, content: string, apiToken?: string): Promise<void> {
    await this.json("PATCH", `${this.appBase}/conversations/${conversationId}/messages/${messageId}`, {
      token: apiToken ?? this.opts.apiToken,
      body: { content },
    });
  }

  async toggleStatusAsAgent(conversationId: number, status: "open" | "resolved" | "pending", apiToken?: string): Promise<void> {
    await this.json("POST", `${this.appBase}/conversations/${conversationId}/toggle_status`, {
      token: apiToken ?? this.opts.apiToken,
      body: { status },
    });
  }

  async assignConversation(conversationId: number, assigneeId: number, apiToken?: string): Promise<void> {
    await this.json("POST", `${this.appBase}/conversations/${conversationId}/assignments`, {
      token: apiToken ?? this.opts.apiToken,
      body: { assignee_id: assigneeId },
    });
  }

  async listAgents(): Promise<ChatwootAgent[]> {
    return this.json<ChatwootAgent[]>("GET", `${this.appBase}/agents`, { token: this.opts.apiToken });
  }

  /** Validate an access token and return its user profile, including the accounts it belongs to. */
  async whoAmI(apiToken: string): Promise<ChatwootProfile> {
    return this.json<ChatwootProfile>("GET", `${this.opts.baseUrl}/api/v1/profile`, { token: apiToken });
  }

  /** Inboxes in an account. API-channel inboxes carry `inbox_identifier`. */
  async listInboxes(accountId: number, apiToken: string): Promise<ChatwootInbox[]> {
    const res = await this.json<{ payload: ChatwootInbox[] } | ChatwootInbox[]>("GET", `${this.opts.baseUrl}/api/v1/accounts/${accountId}/inboxes`, {
      token: apiToken,
    });
    return Array.isArray(res) ? res : res.payload;
  }

  // ---------- plumbing ----------

  private async json<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    init: { token?: string; body?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.token) headers.api_access_token = init.token;
    let body: RequestInit["body"];
    if (init.form) {
      body = init.form;
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    log.debug("chatwoot request", { method, url });
    const res = await this.fetchFn(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok) throw new ChatwootHttpError(res.status, url, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ChatwootHttpError(res.status, url, `non-JSON response: ${text.slice(0, 200)}`);
    }
  }
}
