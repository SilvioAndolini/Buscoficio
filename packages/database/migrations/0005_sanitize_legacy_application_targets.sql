-- Phase 2.2 — legacy sanitization.
--
-- Before the safe default existed, auto-detected application targets were
-- created with status='active' and policy_notes=NULL. Detection is not
-- authorization, so this migration blocks exactly those unreviewed legacy
-- rows. Targets that already carry policy notes (real review evidence) or
-- that are already blocked/paused are left untouched.
--
-- The statement is idempotent: re-running it affects zero rows once applied.
UPDATE "application_target"
SET "status" = 'blocked',
    "policy_notes" = 'Detected ATS target. Discovery association allowed. Submission authorization pending separate platform policy review.'
WHERE "status" = 'active'
  AND "policy_notes" IS NULL;
