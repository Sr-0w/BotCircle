ALTER TABLE "opencode_instances" ADD COLUMN "api_version" text;
--> statement-breakpoint
ALTER TABLE "opencode_instances" ADD COLUMN "auth_kind" text DEFAULT 'password' NOT NULL;
--> statement-breakpoint
ALTER TABLE "opencode_instances" ADD COLUMN "token_expires_at" timestamp with time zone;
