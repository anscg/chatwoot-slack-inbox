CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"slack_user_id" text NOT NULL,
	"chatwoot_agent_id" integer,
	"email" text,
	"slack_user_token_enc" text,
	"chatwoot_api_token_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridges" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"slack_channel" text NOT NULL,
	"slack_bot_token_enc" text NOT NULL,
	"slack_signing_secret_enc" text NOT NULL,
	"slack_bot_id" text,
	"slack_bot_user_id" text,
	"slack_team_id" text,
	"chatwoot_account_id" integer NOT NULL,
	"chatwoot_inbox_identifier" text NOT NULL,
	"chatwoot_api_token_enc" text NOT NULL,
	"reaction_resolve" text,
	"reaction_assign" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relayed" (
	"id" serial PRIMARY KEY NOT NULL,
	"slack_ts" text NOT NULL,
	"slack_channel" text NOT NULL,
	"chatwoot_message_id" integer NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retries" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"slack_channel" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"chatwoot_account_id" integer NOT NULL,
	"chatwoot_conversation_id" integer NOT NULL,
	"chatwoot_contact_source_id" text NOT NULL,
	"slack_author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slack_user_uq" ON "agents" USING btree ("slack_user_id");--> statement-breakpoint
CREATE INDEX "agents_chatwoot_agent_idx" ON "agents" USING btree ("chatwoot_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bridges_channel_uq" ON "bridges" USING btree ("slack_channel");--> statement-breakpoint
CREATE UNIQUE INDEX "bridges_name_uq" ON "bridges" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "bridges_slug_uq" ON "bridges" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "relayed_slack_uq" ON "relayed" USING btree ("slack_channel","slack_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "relayed_chatwoot_uq" ON "relayed" USING btree ("chatwoot_message_id");--> statement-breakpoint
CREATE INDEX "retries_next_attempt_idx" ON "retries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "seen_events_seen_at_idx" ON "seen_events" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_slack_uq" ON "threads" USING btree ("slack_channel","slack_thread_ts");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_conversation_uq" ON "threads" USING btree ("chatwoot_account_id","chatwoot_conversation_id");