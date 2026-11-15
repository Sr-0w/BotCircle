ALTER TABLE "tasks" ADD COLUMN "provider" text DEFAULT 'worker' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external" jsonb;
--> statement-breakpoint
CREATE TABLE "opencode_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"username" text DEFAULT 'opencode' NOT NULL,
	"password" text,
	"default_directory" text,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opencode_exchanges" (
	"seq" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"session_id" text NOT NULL,
	"author" text NOT NULL,
	"agent_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"original" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "opencode_exchanges_task_idx" ON "opencode_exchanges" USING btree ("task_id","seq");
