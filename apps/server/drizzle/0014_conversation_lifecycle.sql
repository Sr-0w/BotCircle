-- #56: archive (reversible) and delete (final) are two different states of a conversation.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
-- Before #56, "archived" on a general chat meant deleted (its messages were already gone).
UPDATE "conversations" SET "deleted_at" = "updated_at" WHERE "kind" = 'chat' AND "archived" = true AND "deleted_at" IS NULL;
