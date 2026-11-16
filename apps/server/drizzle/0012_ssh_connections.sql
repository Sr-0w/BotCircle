-- #52: reusable SSH hosts. Secrets are encrypted at rest and never leave the server.
CREATE TABLE IF NOT EXISTS "ssh_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "host" text NOT NULL,
  "port" integer NOT NULL DEFAULT 22,
  "username" text NOT NULL,
  "auth" text NOT NULL DEFAULT 'key',
  "secret" text,
  "host_key" text,
  "agents" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "approval" text NOT NULL DEFAULT 'ask',
  "enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'unknown',
  "last_error" text,
  "last_ok_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
