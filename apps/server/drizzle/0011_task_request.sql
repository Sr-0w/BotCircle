-- #61: the user request a task belongs to; subtasks of one request share it and report back together.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_request_idx" ON "tasks" ("request_id");
