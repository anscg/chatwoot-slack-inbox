import { App, ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { ChatwootClient } from "./chatwoot/client.js";
import { decryptToken } from "./crypto.js";
import type { Db } from "./db/client.js";
import { eq } from "drizzle-orm";
import { bridges, type BridgeRow } from "./db/schema.js";
import { log } from "./logger.js";

/** A bridge row plus live clients: its own Slack bot (Bolt app + receiver) and a Chatwoot client. */
export interface Bridge {
  row: BridgeRow;
  chatwoot: ChatwootClient;
  /** Chatwoot service token (decrypted). */
  apiToken: string;
  /** This bridge's Slack bot. */
  slack: WebClient;
  botToken: string;
  botId: string;
  botUserId: string;
  /** Bolt app + receiver handling /slack/events/{slug}. */
  bolt: App;
  receiver: ExpressReceiver;
}

export interface BridgeRegistryOptions {
  chatwootBaseUrl: string;
  encryptionKey: Buffer;
  fetchFn?: typeof fetch;
  /** Attach event listeners to a freshly built Bolt app. */
  onBoltApp?: (app: App, bridgeId: number) => void;
  /** Overridable for tests. */
  createSlackClient?: (token: string) => WebClient;
  authTest?: (client: WebClient) => Promise<{ botId: string; botUserId: string }>;
}

/**
 * In-memory view of the `bridges` table with one Bolt app per row. The control panel
 * calls `reload()` after every write; a periodic refresh covers multi-instance deployments.
 * Disabled bridges are kept (so their event URL can answer 200) but never returned by `forChannel`.
 */
export class BridgeRegistry {
  private byChannel = new Map<string, Bridge>();
  private byId = new Map<number, Bridge>();
  private bySlug = new Map<string, Bridge>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly opts: BridgeRegistryOptions,
  ) {}

  async reload(): Promise<void> {
    const rows = await this.db.select().from(bridges);
    const byChannel = new Map<string, Bridge>();
    const byId = new Map<number, Bridge>();
    const bySlug = new Map<string, Bridge>();
    for (const row of rows) {
      const prev = this.byId.get(row.id);
      let bridge: Bridge;
      try {
        bridge = prev && sameSecrets(prev.row, row) ? { ...prev, row, chatwoot: this.chatwootFor(row, prev) } : await this.build(row);
      } catch (err) {
        log.error("bridge failed to load; skipping", { bridge: row.name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      byId.set(row.id, bridge);
      bySlug.set(row.slug, bridge);
      if (row.enabled) byChannel.set(row.slackChannel, bridge);
    }
    this.byChannel = byChannel;
    this.byId = byId;
    this.bySlug = bySlug;
  }

  private chatwootFor(row: BridgeRow, prev?: Bridge): ChatwootClient {
    const apiToken = decryptToken(row.chatwootApiTokenEnc, this.opts.encryptionKey);
    if (
      prev &&
      prev.apiToken === apiToken &&
      prev.row.chatwootAccountId === row.chatwootAccountId &&
      prev.row.chatwootInboxIdentifier === row.chatwootInboxIdentifier
    ) {
      return prev.chatwoot;
    }
    return new ChatwootClient({
      baseUrl: this.opts.chatwootBaseUrl,
      accountId: row.chatwootAccountId,
      inboxIdentifier: row.chatwootInboxIdentifier,
      apiToken,
      fetchFn: this.opts.fetchFn,
    });
  }

  private async build(row: BridgeRow): Promise<Bridge> {
    // eslint-disable-next-line prefer-const
    const apiToken = decryptToken(row.chatwootApiTokenEnc, this.opts.encryptionKey);
    const botToken = decryptToken(row.slackBotTokenEnc, this.opts.encryptionKey);
    const signingSecret = decryptToken(row.slackSigningSecretEnc, this.opts.encryptionKey);
    const slack = (this.opts.createSlackClient ?? ((t) => new WebClient(t, { retryConfig: { retries: 2 } })))(botToken);

    // Prefer the ids cached when the token was saved; otherwise ask Slack once.
    let botId = row.slackBotId ?? "";
    let botUserId = row.slackBotUserId ?? "";
    if (!botId || !botUserId) {
      const auth = await (this.opts.authTest ?? defaultAuthTest)(slack);
      botId = auth.botId;
      botUserId = auth.botUserId;
    }

    const receiver = new ExpressReceiver({ signingSecret, endpoints: "/", processBeforeResponse: false });
    const bolt = new App({
      receiver,
      authorize: async () => ({ botToken, botId, botUserId }),
    });
    bolt.error(async (err) => log.error("bolt error", { bridge: row.name, error: err }));
    this.opts.onBoltApp?.(bolt, row.id);

    const chatwoot = this.chatwootFor(row);
    if (row.chatwootInboxId === null) {
      // Older rows: look the numeric inbox id up once so status webhooks can be attributed.
      try {
        const inbox = (await chatwoot.listInboxes(row.chatwootAccountId, apiToken)).find((i) => i.inbox_identifier === row.chatwootInboxIdentifier);
        if (inbox) {
          await this.db.update(bridges).set({ chatwootInboxId: inbox.id }).where(eq(bridges.id, row.id));
          row = { ...row, chatwootInboxId: inbox.id };
        }
      } catch (err) {
        log.warn("could not backfill chatwoot inbox id", { bridge: row.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    log.info("bridge loaded", { bridge: row.name, slug: row.slug, channel: row.slackChannel, botUserId, enabled: row.enabled });
    return { row, chatwoot, apiToken, slack, botToken, botId, botUserId, bolt, receiver };
  }

  startAutoRefresh(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reload().catch((e) => log.error("bridge reload failed", { error: e })), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Enabled bridge for a channel. */
  forChannel(channel: string): Bridge | undefined {
    return this.byChannel.get(channel);
  }

  /** Any bridge (enabled or not) by event-URL slug. */
  forSlug(slug: string): Bridge | undefined {
    return this.bySlug.get(slug);
  }

  get(id: number): Bridge | undefined {
    return this.byId.get(id);
  }

  /** Enabled bridges. */
  all(): Bridge[] {
    return [...this.byChannel.values()];
  }
}

function sameSecrets(a: BridgeRow, b: BridgeRow): boolean {
  return a.slackBotTokenEnc === b.slackBotTokenEnc && a.slackSigningSecretEnc === b.slackSigningSecretEnc && a.slackBotId === b.slackBotId && a.slackBotUserId === b.slackBotUserId;
}

export async function defaultAuthTest(client: WebClient): Promise<{ botId: string; botUserId: string }> {
  const auth = await client.auth.test();
  if (!auth.bot_id || !auth.user_id) throw new Error("auth.test did not return bot_id/user_id; is this a bot token?");
  return { botId: auth.bot_id, botUserId: auth.user_id };
}
