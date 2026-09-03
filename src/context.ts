import type { WebClient } from "@slack/web-api";
import type { BridgeRegistry } from "./bridges.js";
import type { ChatwootPlatformClient } from "./chatwoot/platform.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { RetryQueue } from "./retry.js";

/** Everything a handler needs. Built once in index.ts; tests construct it with mocks. */
export interface AppContext {
  config: Config;
  db: Db;
  /** The hub Slack app's bot client: user lookups, OAuth. Never posts to channels. */
  hub: WebClient;
  bridges: BridgeRegistry;
  /** Set only when CHATWOOT_PLATFORM_TOKEN is configured; used to auto-attach agent tokens. */
  platform?: ChatwootPlatformClient;
  retry: RetryQueue;
  /** Used to download Chatwoot attachments; overridable in tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}
