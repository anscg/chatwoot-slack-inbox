ALTER TABLE "bridges" ADD COLUMN "reopen_prompt_message" text;--> statement-breakpoint
UPDATE "bridges" SET "reopen_prompt_message" = COALESCE("reopen_prompt_message", 'Your message reopened this help ticket. Do you have a question, or is it accidental?');
