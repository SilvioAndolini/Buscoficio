-- Phase 2.3 — last legacy edge case.
--
-- A target could remain active without structured review evidence in the
-- Phase 2.1 window: it was auto-detected (blocked + pending-review note), then
-- activated through the old PATCH endpoint before reviewed_at/reviewed_by and
-- the strict policy-review gate existed.
--
-- Predicate (conservative):
--   active AND reviewed_at IS NULL AND reviewed_by IS NULL
--   AND (policy_notes IS NULL OR policy_notes matches the auto-generated
--        pending-review wording)
--
-- Why the pattern is safe: the only auto-generated pending wording contains
-- the exact phrase 'pending separate platform policy review' (generic and
-- per-platform variants). Real reviews composed by the system contain
-- 'Review completed' and never that phrase, so textual legacy evidence such as
-- 'Reviewed policy 2026-01-01 by user.' is intentionally left untouched
-- (cannot derive reviewedAt/reviewedBy deterministically; never invent data).
--
-- Idempotent: after the first run the matched rows are blocked and no longer
-- match `status = 'active'`; targets reviewed later (reviewed_at set) never
-- match either.
UPDATE "application_target"
SET "status" = 'blocked',
    "policy_notes" = COALESCE(
      "policy_notes",
      'Detected ATS target. Discovery association allowed. Submission authorization pending separate platform policy review.'
    )
WHERE "status" = 'active'
  AND "reviewed_at" IS NULL
  AND "reviewed_by" IS NULL
  AND (
    "policy_notes" IS NULL
    OR "policy_notes" LIKE '%pending separate platform policy review%'
  );
