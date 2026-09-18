ALTER TABLE "job_match" ADD COLUMN "matching_as_of_date" date;--> statement-breakpoint
-- Phase 3.1 sanitation: embedding caches are derived data. Before the strict
-- provider/model binding existed, a stored vector could not be proven to come
-- from the provider/model its EmbeddingSpace declares, so legacy vectors are
-- invalidated here and regenerated on the next computation. Jobs, resumes and
-- JobMatch history are never touched by this migration.
DELETE FROM "job_embedding";--> statement-breakpoint
DELETE FROM "resume_embedding";
