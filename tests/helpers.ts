import { PGlite } from "@electric-sql/pglite";
import type { WebClient } from "@slack/web-api";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { vi } from "vitest";
import { BridgeRegistry } from "../src/bridges.js";
import type { ChatwootClient } from "../src/chatwoot/client.js";
import type { Config } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { encryptToken } from "../src/crypto.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { RetryQueue } from "../src/retry.js";

export const TEST_KEY = Buffer.alloc(32, 7);

export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  // PGlite's drizzle instance is structurally compatible with the node-postgres one for our queries.
  return db as unknown as Db;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CLIENT_ID: "cid",
    SLACK_CLIENT_SECRET: "csecret",
    CHATWOOT_BASE_URL: "https://chatwoot.test",
    CHATWOOT_WEBHOOK_SECRET: "webhook-secret-1234567890",
    ADMIN_SLACK_USER_IDS: ["U_ADMIN"],
    DATABASE_URL: "postgres://unused",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    PUBLIC_URL: "https://bridge.test",
    PORT: 3000,
    LOG_LEVEL: "error",
    ...overrides,
  };
}

export type MockChatwoot = { [K in keyof ChatwootClient]: ReturnType<typeof vi.fn> };

export function mockChatwoot(): MockChatwoot {
  let nextMessageId = 100;
  return {
    upsertContact: vi.fn(async ({ identifier }: { identifier: string }) => ({ id: 1, source_id: `src-${identifier}` })),
    createConversation: vi.fn(async () => ({ id: 42, inbox_id: 1 })),
    updateContact: vi.fn(async () => undefined),
    createContactMessage: vi.fn(async () => ({ id: nextMessageId++, content: "", message_type: 0, conversation_id: 42 })),
    listContactConversations: vi.fn(async () => [{ id: 42, inbox_id: 1, status: "open" }]),
    toggleStatusAsContact: vi.fn(async () => undefined),
    createAgentMessage: vi.fn(async () => ({ id: nextMessageId++, content: "", message_type: 1, conversation_id: 42 })),
    toggleStatusAsAgent: vi.fn(async () => undefined),
    assignConversation: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => []),
    whoAmI: vi.fn(async () => ({ id: 7, name: "Agent", email: "agent@example.com", accounts: [{ id: 1, name: "Acct" }] })),
    listInboxes: vi.fn(async () => []),
  } as unknown as MockChatwoot;
}

export interface MockSlack {
  users: { info: ReturnType<typeof vi.fn> };
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    postEphemeral: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  files: { uploadV2: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  reactions: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  conversations: { history: ReturnType<typeof vi.fn> };
}

export function mockSlack(): MockSlack {
  return {
    reactions: { add: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) },
    conversations: { history: vi.fn(async ({ latest }: { latest: string }) => ({ ok: true, messages: [{ ts: latest }] })) },
    files: {
      uploadV2: vi.fn(async () => ({ ok: true, files: [{ files: [{ id: "F_BOT1" }] }] })),
      info: vi.fn(async () => ({ ok: true, file: { shares: { public: { C_HELP: [{ ts: "1700000000.000700" }] } } } })),
    },
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        ok: true,
        user: {
          id: user,
          real_name: `Real ${user}`,
          profile: { display_name: `Name ${user}`, email: `${user.toLowerCase()}@example.com`, image_192: `https://avatars.test/${user}.png` },
        },
      })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: `${Date.now() / 1000}` })),
      postEphemeral: vi.fn(async () => ({ ok: true })),
      update: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
    },
  };
}

export interface TestContext extends AppContext {
  chatwootMock: MockChatwoot;
  /** Serves as both the hub client (users.info) and every bridge's bot client (chat.postMessage). */
  slackMock: MockSlack;
}

export interface BridgeOverrides {
  name?: string;
  channel?: string;
  accountId?: number;
  reactionResolve?: string | null;
  reactionAssign?: string | null;
  resolvedEmoji?: string | null;
  welcomeMessage?: string | null;
  resolveButtonLabel?: string | null;
  reopenButtonLabel?: string | null;
}

/**
 * Build an AppContext with one bridge (channel C_HELP, account 1) whose Chatwoot
 * client is the mock. Extra bridges can be added with `addBridge`.
 */
export async function makeContext(opts: { bridge?: BridgeOverrides | false; config?: Partial<Config> } = {}): Promise<TestContext> {
  const db = await createTestDb();
  const chatwootMock = mockChatwoot();
  const slackMock = mockSlack();
  const config = testConfig(opts.config ?? {});
  const registry = new BridgeRegistry(db, {
    chatwootBaseUrl: config.CHATWOOT_BASE_URL,
    encryptionKey: TEST_KEY,
    createSlackClient: () => slackMock as unknown as WebClient,
    authTest: async () => ({ botId: "B_OURS", botUserId: "U_BOT" }),
  });
  const ctx: TestContext = {
    config,
    db,
    hub: slackMock as unknown as WebClient,
    bridges: registry,
    retry: new RetryQueue(db),
    chatwootMock,
    slackMock,
  };
  if (opts.bridge !== false) await addBridge(ctx, opts.bridge ?? {}, chatwootMock);
  return ctx;
}

export async function addBridge(ctx: TestContext, over: BridgeOverrides, chatwoot: MockChatwoot = ctx.chatwootMock): Promise<void> {
  await ctx.db.insert(schema.bridges).values({
    name: over.name ?? "help",
    slug: over.name ?? "help",
    slackChannel: over.channel ?? "C_HELP",
    slackBotTokenEnc: encryptToken("xoxb-bridge-bot", TEST_KEY),
    slackSigningSecretEnc: encryptToken("signing-secret", TEST_KEY),
    chatwootAccountId: over.accountId ?? 1,
    chatwootInboxIdentifier: `inbox-${over.accountId ?? 1}`,
    chatwootInboxId: 10 + (over.accountId ?? 1),
    welcomeMessage: over.welcomeMessage === undefined ? "Hi there :neocat_approve: a helper will be with you soon." : over.welcomeMessage,
    resolveButtonLabel: over.resolveButtonLabel === undefined ? "Resolve" : over.resolveButtonLabel,
    reopenButtonLabel: over.reopenButtonLabel === undefined ? "Reopen" : over.reopenButtonLabel,
    resolveMessage: ":neocat: Help request marked as resolved.",
    reopenMessage: "Thread reopened.",
    chatwootApiTokenEnc: encryptToken("service-token", TEST_KEY),
    reactionResolve: over.reactionResolve === undefined ? "white_check_mark" : over.reactionResolve,
    reactionAssign: over.reactionAssign === undefined ? "eyes" : over.reactionAssign,
    resolvedEmoji: over.resolvedEmoji === undefined ? "white_check_mark" : over.resolvedEmoji,
  });
  await ctx.bridges.reload();
  // Swap the real client for the mock so nothing hits the network.
  const b = ctx.bridges.forChannel(over.channel ?? "C_HELP")!;
  b.chatwoot = chatwoot as unknown as ChatwootClient;
}

/** Let fire-and-forget promises settle. */
export const flush = () => new Promise((r) => setTimeout(r, 20));
