ALTER TABLE "bridges" ADD COLUMN "resolve_button_label" text;--> statement-breakpoint
UPDATE "bridges" SET "resolve_button_label" = COALESCE("resolve_button_label", 'Resolve');
