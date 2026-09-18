CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_estimate_usd" numeric(12, 6),
	"confidence" numeric(5, 4),
	"latency_ms" integer NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"application_id" uuid,
	"job_id" uuid,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_embedding" (
	"job_id" uuid NOT NULL,
	"embedding_space_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_embedding_pk" PRIMARY KEY("job_id","embedding_space_id")
);
--> statement-breakpoint
CREATE TABLE "job_match" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"overall_score" numeric(5, 4) NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"missing_requirements" text[] DEFAULT '{}'::text[] NOT NULL,
	"matching_skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"recommended_resume_id" uuid,
	"engine_version" text NOT NULL,
	"weights_version" text NOT NULL,
	"job_content_hash" text NOT NULL,
	"candidate_profile_hash" text NOT NULL,
	"resume_set_hash" text NOT NULL,
	"embedding_space_id" uuid,
	"identity_hash" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"semantic_model" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resume_embedding" (
	"resume_version_id" uuid NOT NULL,
	"embedding_space_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_embedding_pk" PRIMARY KEY("resume_version_id","embedding_space_id")
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_embedding" ADD CONSTRAINT "job_embedding_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_embedding" ADD CONSTRAINT "job_embedding_embedding_space_id_embedding_space_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match" ADD CONSTRAINT "job_match_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match" ADD CONSTRAINT "job_match_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match" ADD CONSTRAINT "job_match_recommended_resume_id_resume_id_fk" FOREIGN KEY ("recommended_resume_id") REFERENCES "public"."resume"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match" ADD CONSTRAINT "job_match_embedding_space_id_embedding_space_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_space"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_embedding" ADD CONSTRAINT "resume_embedding_resume_version_id_resume_version_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_embedding" ADD CONSTRAINT "resume_embedding_embedding_space_id_embedding_space_id_fk" FOREIGN KEY ("embedding_space_id") REFERENCES "public"."embedding_space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_operation_created_idx" ON "ai_usage" USING btree ("operation","created_at");--> statement-breakpoint
CREATE INDEX "job_embedding_hnsw_idx" ON "job_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "job_match_identity_uq" ON "job_match" USING btree ("job_id","candidate_id","identity_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "job_match_current_uq" ON "job_match" USING btree ("job_id","candidate_id") WHERE "job_match"."is_current" = true;--> statement-breakpoint
CREATE INDEX "job_match_ranking_idx" ON "job_match" USING btree ("candidate_id","overall_score" desc) WHERE "job_match"."is_current" = true;--> statement-breakpoint
CREATE INDEX "job_match_computed_idx" ON "job_match" USING btree ("computed_at" desc);--> statement-breakpoint
CREATE INDEX "resume_embedding_hnsw_idx" ON "resume_embedding" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_space_active_uq" ON "embedding_space" USING btree ("status") WHERE "embedding_space"."status" = 'active';