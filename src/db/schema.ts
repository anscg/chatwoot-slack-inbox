import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One Slack channel <-> one Chatwoot API inbox, with its own Slack app (bot).
 * Managed from the control panel. Events for this bridge arrive at /slack/events/{slug}.
 */
export const bridges = pgTable(
  "bridges",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    /** URL-safe id used in the Slack Request URL. Changing it breaks the Slack app config. */
    slug: text("slug").notNull(),
    slackChannel: text("slack_channel").notNull(),
    slackBotTokenEnc: text("slack_bot_token_enc").notNull(),
    slackSigningSecretEnc: text("slack_signing_secret_enc").notNull(),
    /** Cached from auth.test when the token is saved. */
    slackBotId: text("slack_bot_id"),
    slackBotUserId: text("slack_bot_user_id"),
    slackTeamId: text("slack_team_id"),
    chatwootAccountId: integer("chatwoot_account_id").notNull(),
    chatwootInboxIdentifier: text("chatwoot_inbox_identifier").notNull(),
    /** Service-agent access token for this account, used when no per-agent token applies. */
    chatwootApiTokenEnc: text("chatwoot_api_token_enc").notNull(),
    /** Emoji short names; null disables the reaction. */
    reactionResolve: text("reaction_resolve"),
    reactionAssign: text("reaction_assign"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bridges_channel_uq").on(t.slackChannel), uniqueIndex("bridges_name_uq").on(t.name), uniqueIndex("bridges_slug_uq").on(t.slug)],
);

/** One row per bridged Slack thread <-> Chatwoot conversation. */
export const threads = pgTable(
  "threads",
  {
    id: serial("id").primaryKey(),
    slackChannel: text("slack_channel").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    chatwootAccountId: integer("chatwoot_account_id").notNull(),
    /** Chatwoot's per-account conversation `display_id` (what the APIs and webhooks call `id`). */
    chatwootConversationId: integer("chatwoot_conversation_id").notNull(),
    chatwootContactSourceId: text("chatwoot_contact_source_id").notNull(),
    slackAuthorId: text("slack_author_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("threads_slack_uq").on(t.slackChannel, t.slackThreadTs),
    uniqueIndex("threads_conversation_uq").on(t.chatwootAccountId, t.chatwootConversationId),
  ],
);

/** Slack users who linked their account; may hold a Slack user token and/or a Chatwoot API token. */
export const agents = pgTable(
  "agents",
  {
    id: serial("id").primaryKey(),
    slackUserId: text("slack_user_id").notNull(),
    chatwootAgentId: integer("chatwoot_agent_id"),
    email: text("email"),
    slackUserTokenEnc: text("slack_user_token_enc"),
    chatwootApiTokenEnc: text("chatwoot_api_token_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_slack_user_uq").on(t.slackUserId),
    index("agents_chatwoot_agent_idx").on(t.chatwootAgentId),
  ],
);

/** Slack event_id dedupe, pruned after 24h. */
export const seenEvents = pgTable(
  "seen_events",
  {
    eventId: text("event_id").primaryKey(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seen_events_seen_at_idx").on(t.seenAt)],
);

/** Every message the bridge relayed in either direction, so echoes can be dropped. */
export const relayed = pgTable(
  "relayed",
  {
    id: serial("id").primaryKey(),
    slackTs: text("slack_ts").notNull(),
    slackChannel: text("slack_channel").notNull(),
    chatwootMessageId: integer("chatwoot_message_id").notNull(),
    direction: text("direction", { enum: ["slack_to_chatwoot", "chatwoot_to_slack"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("relayed_slack_uq").on(t.slackChannel, t.slackTs),
    uniqueIndex("relayed_chatwoot_uq").on(t.chatwootMessageId),
  ],
);

/** Failed outbound calls awaiting retry with exponential backoff. */
/**
 * Slack file IDs the bridge itself uploaded (Chatwoot -> Slack). File-share messages made with a
 * user token carry no bot_id or metadata, so this is how we recognise them when they echo back.
 */
export const relayedFiles = pgTable("relayed_files", {
  slackFileId: text("slack_file_id").primaryKey(),
  chatwootMessageId: integer("chatwoot_message_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const retries = pgTable(
  "retries",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("retries_next_attempt_idx").on(t.nextAttemptAt)],
);

export type BridgeRow = typeof bridges.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Retry = typeof retries.$inferSelect;
