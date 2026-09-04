CREATE TABLE "held_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"slack_channel" text NOT NULL,
	"slack_ts" text NOT NULL,
	"slack_user" text NOT NULL,
	"prior_thread_ts" text NOT NULL,
	"payload" jsonb NOT NULL,
	"answered_at" timestamp with time zone,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "followup_prompt_message" text;--> statement-breakpoint
CREATE UNIQUE INDEX "held_messages_slack_uq" ON "held_messages" USING btree ("slack_channel","slack_ts");