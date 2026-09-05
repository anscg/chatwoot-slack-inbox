ALTER TABLE "agents" ADD COLUMN "email_source" text;--> statement-breakpoint
-- Rows we already matched to a Chatwoot user: that address is theirs by definition. Everyone
-- else keeps a null source, which callers read as "we do not know, guess from the Slack profile".
UPDATE "agents" SET "email_source" = 'chatwoot' WHERE "chatwoot_agent_id" IS NOT NULL AND "email" IS NOT NULL;
