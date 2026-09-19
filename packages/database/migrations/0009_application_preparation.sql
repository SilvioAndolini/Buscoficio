CREATE TABLE "application" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_target_id" uuid,
	"discovery_source_id" uuid,
	"match_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"resume_version_id" uuid,
	"idempotency_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"score_at_creation" numeric(5, 4) NOT NULL,
	"preparation_snapshot" jsonb,
	"supersedes_application_id" uuid,
	"submitted_at" timestamp with time zone,
	"last_transition_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requires_human_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"question_hash" text NOT NULL,
	"answer_text" text,
	"answer_kind" text NOT NULL,
	"source_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_human_input" boolean DEFAULT false NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_document" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"resume_version_id" uuid,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_candidate_id_candidate_profile_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_application_target_id_application_target_id_fk" FOREIGN KEY ("application_target_id") REFERENCES "public"."application_target"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_discovery_source_id_job_source_id_fk" FOREIGN KEY ("discovery_source_id") REFERENCES "public"."job_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_match_id_job_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."job_match"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_resume_version_id_resume_version_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_supersedes_application_id_application_id_fk" FOREIGN KEY ("supersedes_application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_answer" ADD CONSTRAINT "application_answer_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_document" ADD CONSTRAINT "application_document_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_document" ADD CONSTRAINT "application_document_resume_version_id_resume_version_id_fk" FOREIGN KEY ("resume_version_id") REFERENCES "public"."resume_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_idempotency_key_uq" ON "application" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "application_active_job_candidate_uq" ON "application" USING btree ("candidate_id","job_id") WHERE "application"."status" NOT IN ('ARCHIVED', 'REJECTED');--> statement-breakpoint
CREATE INDEX "application_status_transition_idx" ON "application" USING btree ("status","last_transition_at");--> statement-breakpoint
CREATE INDEX "application_job_idx" ON "application" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "application_target_idx" ON "application" USING btree ("application_target_id");--> statement-breakpoint
CREATE INDEX "application_candidate_status_idx" ON "application" USING btree ("candidate_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "application_answer_question_uq" ON "application_answer" USING btree ("application_id","question_hash");--> statement-breakpoint
CREATE INDEX "application_answer_question_hash_idx" ON "application_answer" USING btree ("question_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "application_document_content_uq" ON "application_document" USING btree ("application_id","kind","content_hash");--> statement-breakpoint
CREATE INDEX "application_document_application_idx" ON "application_document" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "application_document_input_hash_idx" ON "application_document" USING btree (("generated_by"->>'inputHash'));--> statement-breakpoint
CREATE INDEX "application_event_application_time_idx" ON "application_event" USING btree ("application_id","occurred_at");--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE set null ON UPDATE no action;