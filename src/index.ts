import { existsSync } from "node:fs";
import { WebClient } from "@slack/web-api";
import express from "express";
import { registerAdminApi } from "./admin/api.js";
import { BridgeRegistry } from "./bridges.js";
import { registerChatwootWebhook } from "./chatwoot/webhook.js";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { createDb, runMigrations } from "./db/client.js";
import { log, setLogLevel } from "./logger.js";
import { RetryQueue } from "./retry.js";
import { registerSlackEvents, registerSlackJobs } from "./slack/events.js";
import { registerSlackOAuth } from "./slack/oauth.js";
import { registerSetupRoutes } from "./setup.js";
import { pruneSeenEvents } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  const { db, pool } = createDb(config.DATABASE_URL);
  await runMigrations(db);
  log.info("migrations applied");

  // Hub app: admin sign-in, /link, user lookups. Bridges each bring their own bot.
  const hub = new WebClient(config.SLACK_BOT_TOKEN, { retryConfig: { retries: 2 } });
  // Not fatal: on a fresh install the hub app doesn't exist yet, and /setup hands out its manifest.
  const hubAuth = await hub.auth.test().catch((err: unknown) => {
    log.warn("hub Slack app not usable yet; sign-in and /link will fail until SLACK_* are set", {
      setupUrl: `${config.PUBLIC_URL}/setup`,
      error: err instanceof Error ? err.message : String(err),
    });
    return { user_id: undefined as string | undefined };
  });

  const retry = new RetryQueue(db);
  // `ctx.bridges` is assigned right after; handlers only touch it at event time.
  const ctx = { config, db, hub, retry } as AppContext;
  const bridges = new BridgeRegistry(db, {
    chatwootBaseUrl: config.CHATWOOT_BASE_URL,
    encryptionKey: config.TOKEN_ENCRYPTION_KEY,
    onBoltApp: (app, bridgeId) => registerSlackEvents(app, ctx, bridgeId),
  });
  ctx.bridges = bridges;
  await bridges.reload();
  bridges.startAutoRefresh();
  if (bridges.all().length === 0) log.warn("no enabled bridges yet; see setup page", { setupUrl: `${config.PUBLIC_URL}/setup`, adminUrl: `${config.PUBLIC_URL}/admin/` });

  registerSlackJobs(ctx);

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Each bridge's Slack app posts events to /slack/events/{slug}; Bolt verifies the signature
  // with that bridge's signing secret and acks before our listeners run.
  app.use("/slack/events/:slug", (req, res, next) => {
    const bridge = bridges.forSlug(String(req.params.slug));
    if (!bridge) {
      res.status(404).json({ error: "unknown bridge" });
      return;
    }
    if (!bridge.row.enabled) {
      res.status(200).end(); // keep Slack from disabling the subscription while paused
      return;
    }
    bridge.receiver.app(req, res, next);
  });

  app.use("/webhooks", express.json({ limit: "2mb" }));
  registerChatwootWebhook(app, ctx);
  registerSlackOAuth(app, ctx);
  registerSetupRoutes(app, config);
  registerAdminApi(app, ctx);

  // Control panel SPA (built by `npm run build` into web/dist).
  const webDist = new URL("../web/dist", import.meta.url).pathname;
  if (existsSync(webDist)) {
    app.use("/admin", express.static(webDist, { index: "index.html" }));
    app.get(/^\/admin(\/.*)?$/, (_req, res) => {
      res.sendFile(`${webDist}/index.html`);
    });
  } else {
    log.warn("web/dist not found; control panel UI unavailable (run `npm run build:web`)");
  }

  retry.start();
  const prune = setInterval(() => void pruneSeenEvents(db).catch((e) => log.error("prune failed", { error: e })), 60 * 60_000);
  prune.unref();

  const server = app.listen(config.PORT, () => {
    log.info("listening", {
      port: config.PORT,
      publicUrl: config.PUBLIC_URL,
      hubBot: hubAuth.user_id ?? "(not configured)",
      bridges: bridges.all().map((b) => `${b.row.name} (${b.row.slackChannel} -> account ${b.row.chatwootAccountId}, bot ${b.botUserId})`),
    });
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    retry.stop();
    bridges.stop();
    clearInterval(prune);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: err });
  process.exit(1);
});
