CREATE TABLE "secure_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"task_id" text,
	"origin" text NOT NULL,
	"url" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "secure_logins_agent_idx" ON "secure_logins" USING btree ("agent_id","status");
