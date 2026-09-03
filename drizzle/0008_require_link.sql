ALTER TABLE "bridges" ADD COLUMN "require_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "link_prompt_message" text;--> statement-breakpoint
UPDATE "bridges" SET "link_prompt_message" = COALESCE("link_prompt_message", 'Before you can post here, link your Slack account: {link}');
