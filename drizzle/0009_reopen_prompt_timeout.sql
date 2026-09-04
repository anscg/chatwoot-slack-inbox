ALTER TABLE "threads" ADD COLUMN "reopen_prompt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "reopen_prompt_user" text;