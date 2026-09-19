ALTER TABLE "application_answer" ALTER COLUMN "source_refs" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "application_answer" ALTER COLUMN "claims" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "application_document" ALTER COLUMN "claims" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
UPDATE "application_answer" SET "source_refs" = '[]'::jsonb WHERE "source_refs" = '{}'::jsonb;--> statement-breakpoint
UPDATE "application_answer" SET "claims" = '[]'::jsonb WHERE "claims" = '{}'::jsonb;--> statement-breakpoint
UPDATE "application_document" SET "claims" = '[]'::jsonb WHERE "claims" = '{}'::jsonb;
