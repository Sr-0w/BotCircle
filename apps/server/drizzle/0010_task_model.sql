-- The model a task was asked to use (explicit) and the model that really served it.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "model" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "used_model" text;
