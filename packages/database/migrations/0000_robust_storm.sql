CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "application_target" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_required" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_language" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"language" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"headline" text,
	"summary" text,
	"location_city" text,
	"location_country" text,
	"location_timezone" text,
	"availability_date" date,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text,
	"remote_preference" text[] DEFAULT '{}'::text[] NOT NULL,
	"employment_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"relocation" boolean DEFAULT false NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_hash" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_skill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"level" text NOT NULL,
	"years" numeric(4, 1),
	"evidence_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"chosen" jsonb,
	"confidence" numeric(5, 4),
	"threshold" numeric(5, 4),
	"outcome" text DEFAULT 'pending' NOT NULL,
	"application_id" uuid,
	"automation_run_id" uuid,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"institution" text NOT NULL,
	"degree" text NOT NULL,
	"field" text,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_space" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"distance_metric" text DEFAULT 'cosine' NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experience" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"description" text DEFAULT '' NOT NULL,
	"location" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"primary_listing_id" uuid,
	"application_target_id" uuid,
	"application_target_resolved_at" timestamp with time zone,
	"company" text NOT NULL,
	"company_norm" text NOT NULL,
	"title" text NOT NULL,
	"title_norm" text NOT NULL,
	"description" text NOT NULL,
	"location" text,
	"remote_type" text,
	"employment_type" text,
	"salary_min" integer,
	"salary_max" integer,
	"currency" text,
	"experience_level" text,
	"required_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"language_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"application_method" text DEFAULT 'unknown' NOT NULL,
	"dedup_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"merged_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_listing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"job_id" uuid,
	"application_target_id" uuid,
	"application_target_signal" text,
	"canonical_url" text,
	"url_hash" text,
	"company" text,
	"company_norm" text,
	"title" text,
	"title_norm" text,
	"description" text,
	"description_norm" text,
	"description_fingerprint" text,
	"location" text,
	"remote_type" text,
	"employment_type" text,
	"salary_min" integer,
	"salary_max" integer,
	"currency" text,
	"experience_level" text,
	"language_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"application_method" text DEFAULT 'unknown' NOT NULL,
	"raw" jsonb,
	"raw_ref" text,
	"status" text DEFAULT 'active' NOT NULL,
	"validated" boolean DEFAULT true NOT NULL,
	"validation_errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "job_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resume_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"parent_version_id" uuid,
	"kind" text DEFAULT 'original' NOT NULL,
	"storage_key" text NOT NULL,
	"file_hash" text NOT NULL,
	"highlights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_config" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"locations" text[] DEFAULT '{}'::text[] NOT NULL,
	"remote" boolean,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"interval_minutes" integer DEFAULT 1440 NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'assisted' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"search_config_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_new" integer DEFAULT 0 NOT NULL,
	"jobs_duplicated" integer DEFAULT 0 NOT NULL,
	"jobs_rejected" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_source_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"search_run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"jobs_discovered" integer DEFAULT 0 NOT NULL,
	"jobs_new" integer DEFAULT 0 NOT NULL,
	"jobs_duplicated" integer DEFAULT 0 NOT NULL,
	"jobs_rejected" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error_class" text,
	"error_detail" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_language" ADD CONSTRAINT "candidate_language_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill" ADD CONSTRAINT "candidate_skill_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_skill" ADD CONSTRAINT "candidate_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education" ADD CONSTRAINT "education_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experience" ADD CONSTRAINT "experience_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_primary_listing_id_job_listing_id_fk" FOREIGN KEY ("primary_listing_id") REFERENCES "public"."job_listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_application_target_id_application_target_id_fk" FOREIGN KEY ("application_target_id") REFERENCES "public"."application_target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_listing" ADD CONSTRAINT "job_listing_source_id_job_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_listing" ADD CONSTRAINT "job_listing_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_listing" ADD CONSTRAINT "job_listing_application_target_id_application_target_id_fk" FOREIGN KEY ("application_target_id") REFERENCES "public"."application_target"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume" ADD CONSTRAINT "resume_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_version" ADD CONSTRAINT "resume_version_resume_id_resume_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resume"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_config" ADD CONSTRAINT "search_config_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_run" ADD CONSTRAINT "search_run_search_config_id_search_config_id_fk" FOREIGN KEY ("search_config_id") REFERENCES "public"."search_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_source_run" ADD CONSTRAINT "search_source_run_search_run_id_search_run_id_fk" FOREIGN KEY ("search_run_id") REFERENCES "public"."search_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_source_run" ADD CONSTRAINT "search_source_run_source_id_job_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_target_key_uq" ON "application_target" USING btree ("key");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_language_candidate_language_uq" ON "candidate_language" USING btree ("candidate_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_skill_candidate_skill_uq" ON "candidate_skill" USING btree ("candidate_id","skill_id");--> statement-breakpoint
CREATE INDEX "candidate_skill_candidate_idx" ON "candidate_skill" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "decision_log_task_created_idx" ON "decision_log" USING btree ("task","created_at");--> statement-breakpoint
CREATE INDEX "decision_log_outcome_idx" ON "decision_log" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "education_candidate_idx" ON "education" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_space_key_uq" ON "embedding_space" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_space_provider_model_dim_version_uq" ON "embedding_space" USING btree ("provider","model","dimensions","version");--> statement-breakpoint
CREATE INDEX "experience_candidate_start_idx" ON "experience" USING btree ("candidate_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedup_key_uq" ON "job" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "job_status_published_idx" ON "job" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "job_target_idx" ON "job" USING btree ("application_target_id");--> statement-breakpoint
CREATE INDEX "job_title_trgm_idx" ON "job" USING gin ("title_norm" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "job_listing_source_external_uq" ON "job_listing" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "job_listing_job_idx" ON "job_listing" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_listing_url_hash_idx" ON "job_listing" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "job_listing_fingerprint_idx" ON "job_listing" USING btree ("description_fingerprint");--> statement-breakpoint
CREATE INDEX "job_listing_target_idx" ON "job_listing" USING btree ("application_target_id");--> statement-breakpoint
CREATE INDEX "job_listing_discovered_idx" ON "job_listing" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "job_listing_title_trgm_idx" ON "job_listing" USING gin ("title_norm" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "job_listing_company_trgm_idx" ON "job_listing" USING gin ("company_norm" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "job_source_key_uq" ON "job_source" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_candidate_category_language_uq" ON "resume" USING btree ("candidate_id","category","language");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_version_resume_version_uq" ON "resume_version" USING btree ("resume_id","version_number");--> statement-breakpoint
CREATE INDEX "resume_version_resume_idx" ON "resume_version" USING btree ("resume_id");--> statement-breakpoint
CREATE INDEX "search_config_active_idx" ON "search_config" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "search_run_config_started_idx" ON "search_run" USING btree ("search_config_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "search_source_run_run_source_uq" ON "search_source_run" USING btree ("search_run_id","source_id");--> statement-breakpoint
CREATE INDEX "search_source_run_source_idx" ON "search_source_run" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_canonical_name_uq" ON "skill" USING btree ("canonical_name");