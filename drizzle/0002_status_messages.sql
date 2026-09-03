ALTER TABLE "bridges" ADD COLUMN "chatwoot_inbox_id" integer;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "welcome_message" text;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "resolve_message" text;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "reopen_message" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "status_message_ts" text;--> statement-breakpoint
UPDATE "bridges" SET
  "welcome_message" = COALESCE("welcome_message", 'Hi there :neocat_approve: a helper should be with you soon to help you! Please be patient in the meantime.'),
  "resolve_message" = COALESCE("resolve_message", ':neocat: Help request marked as resolved.'),
  "reopen_message" = COALESCE("reopen_message", 'Thread reopened.');
