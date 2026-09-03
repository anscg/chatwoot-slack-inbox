CREATE TABLE "relayed_files" (
	"slack_file_id" text PRIMARY KEY NOT NULL,
	"chatwoot_message_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
