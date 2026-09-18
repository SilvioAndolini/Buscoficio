CREATE TABLE "dedup_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_job_id" uuid NOT NULL,
	"created_job_id" uuid NOT NULL,
	"listing_id" uuid,
	"source_id" uuid,
	"score" numeric(5, 4) NOT NULL,
	"title_similarity" numeric(5, 4) NOT NULL,
	"description_similarity" numeric(5, 4) NOT NULL,
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "description_norm" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "location_norm" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "dedup_review" ADD CONSTRAINT "dedup_review_candidate_job_id_job_id_fk" FOREIGN KEY ("candidate_job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_review" ADD CONSTRAINT "dedup_review_created_job_id_job_id_fk" FOREIGN KEY ("created_job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_review" ADD CONSTRAINT "dedup_review_listing_id_job_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."job_listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_review" ADD CONSTRAINT "dedup_review_source_id_job_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dedup_review_status_idx" ON "dedup_review" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "dedup_review_candidate_idx" ON "dedup_review" USING btree ("candidate_job_id");--> statement-breakpoint
CREATE INDEX "dedup_review_created_idx" ON "dedup_review" USING btree ("created_job_id");--> statement-breakpoint
CREATE INDEX "job_company_location_idx" ON "job" USING btree ("company_norm","location_norm");--> statement-breakpoint
UPDATE "job" SET "description_norm" = regexp_replace(lower("description"), '\s+', ' ', 'g'), "location_norm" = regexp_replace(lower(coalesce("location", '')), '\s+', ' ', 'g');
