CREATE TABLE "admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"slack_user_id" text NOT NULL,
	"name" text,
	"role" text DEFAULT 'operator' NOT NULL,
	"invited_by" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"bridge_id" integer NOT NULL,
	"slack_user_id" text NOT NULL,
	"role" text DEFAULT 'operator' NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_members" ADD CONSTRAINT "bridge_members_bridge_id_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_slack_user_uq" ON "admin_users" USING btree ("slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_members_uq" ON "bridge_members" USING btree ("bridge_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "bridge_members_user_idx" ON "bridge_members" USING btree ("slack_user_id");