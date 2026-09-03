ALTER TABLE "bridges" ADD COLUMN "resolved_emoji" text;--> statement-breakpoint
UPDATE "bridges" SET "resolved_emoji" = COALESCE("resolved_emoji", 'white_check_mark');
