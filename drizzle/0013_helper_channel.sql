CREATE TABLE "helper_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"bridge_id" integer NOT NULL,
	"slack_user_id" text,
	"action" text NOT NULL,
	"detail" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helper_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"bridge_id" integer NOT NULL,
	"slack_user_id" text NOT NULL,
	"name" text,
	"email" text,
	"chatwoot_user_id" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"in_channel" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"provisioned_at" timestamp with time zone,
	"unlinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_channel" text;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_auto_provision" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_offboarding" text DEFAULT 'unlink' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_max_batch" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_chatwoot_role" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "helper_paused_reason" text;--> statement-breakpoint
ALTER TABLE "helper_events" ADD CONSTRAINT "helper_events_bridge_id_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_members" ADD CONSTRAINT "helper_members_bridge_id_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "helper_events_bridge_idx" ON "helper_events" USING btree ("bridge_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "helper_members_uq" ON "helper_members" USING btree ("bridge_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "helper_members_bridge_idx" ON "helper_members" USING btree ("bridge_id");