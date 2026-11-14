ALTER TABLE "conversations" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model" jsonb;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "conversations_kind_idx" ON "conversations" USING btree ("kind","updated_at");
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text,
	"source" text NOT NULL,
	"conversation_id" text,
	"task_id" text,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "artifacts_conversation_idx" ON "artifacts" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX "artifacts_sha_idx" ON "artifacts" USING btree ("sha256");
--> statement-breakpoint
CREATE TABLE "artifact_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"granted_by" text NOT NULL,
	"via" text NOT NULL,
	"conversation_id" text,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "artifact_grants_artifact_idx" ON "artifact_grants" USING btree ("artifact_id");
--> statement-breakpoint
CREATE INDEX "artifact_grants_agent_idx" ON "artifact_grants" USING btree ("agent_id");
--> statement-breakpoint
CREATE TABLE "artifact_access" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artifact_access_artifact_idx" ON "artifact_access" USING btree ("artifact_id","created_at");
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"work_conversation_id" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text,
	"current_action" text,
	"completed_steps" integer DEFAULT 0 NOT NULL,
	"total_steps" integer,
	"blocker" text,
	"requires_user_input" boolean DEFAULT false NOT NULL,
	"result" text,
	"error" text,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" text DEFAULT 'agent' NOT NULL,
	"last_heartbeat" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "tasks_agent_idx" ON "tasks" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX "tasks_conversation_idx" ON "tasks" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE TABLE "task_events" (
	"seq" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","seq");
