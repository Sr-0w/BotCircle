-- Per-chat controls: web search on/off (enforced on the tools given to the model), pinning.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "web_search" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;
