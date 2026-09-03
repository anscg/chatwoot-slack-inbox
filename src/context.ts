import type { WebClient } from "@slack/web-api";
import type { BridgeRegistry } from "./bridges.js";
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
  retry: RetryQueue;
  /** Used to download Chatwoot attachments; overridable in tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}
