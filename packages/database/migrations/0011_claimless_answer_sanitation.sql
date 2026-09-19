-- Phase 4.2: claimless free-text answers are human-only.
-- A row with zero structured claims can never be auto-approved/reused, even if
-- legacy flags (approved=true / verification.status='verified') say otherwise.
-- Rows with claims (jsonb_array_length > 0) keep their historical validation.
UPDATE "application_answer"
SET "approved" = false,
    "requires_human_input" = true,
    "verification" = jsonb_build_object(
      'status', 'unverifiable',
      'failures', '[]'::jsonb,
      'reason', 'Claimless free-text answer requires human review under Phase 4.2 policy.'
    )
WHERE jsonb_typeof("claims") = 'array'
  AND jsonb_array_length("claims") = 0
  AND ("approved" = true OR "verification" ->> 'status' = 'verified');
