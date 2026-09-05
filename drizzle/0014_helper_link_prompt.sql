ALTER TABLE "bridges" ADD COLUMN "helper_link_prompt" text;--> statement-breakpoint
ALTER TABLE "helper_members" ADD COLUMN "link_asked_at" timestamp with time zone;