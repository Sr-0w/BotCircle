-- Where an approval comes from (github, gmail, computer, terminal…), to show its provenance.
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "service" text;
