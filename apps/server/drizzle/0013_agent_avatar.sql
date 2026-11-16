-- #50: a Circle's silhouette (preset or validated custom outline) and the previous one, to restore it.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "avatar" jsonb;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "avatar_previous" jsonb;
