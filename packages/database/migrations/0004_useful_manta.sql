ALTER TABLE "application_target" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_target" ADD COLUMN "reviewed_by" text;