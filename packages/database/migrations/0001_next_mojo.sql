DROP INDEX "resume_candidate_category_language_uq";--> statement-breakpoint
ALTER TABLE "resume_version" ADD CONSTRAINT "resume_version_parent_version_id_resume_version_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."resume_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resume_candidate_idx" ON "resume" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "resume_version_parent_idx" ON "resume_version" USING btree ("parent_version_id");