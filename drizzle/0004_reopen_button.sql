ALTER TABLE "bridges" ADD COLUMN "reopen_button_label" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "welcome_message_ts" text;--> statement-breakpoint
UPDATE "bridges" SET "reopen_button_label" = COALESCE("reopen_button_label", 'Reopen');
