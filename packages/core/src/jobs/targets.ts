/**
 * Safe-default policy metadata for auto-detected submission targets.
 * Detection is NOT authorization: a target discovered by hostname/redirect
 * must not be considered approved for submission (that review belongs to the
 * platform policy process, Phases 5/6).
 */
export const ATS_TARGET_DEFAULT_POLICY_NOTE =
  'Detected ATS target. Discovery association allowed. Submission authorization pending separate platform policy review.';

export const ATS_TARGET_POLICY_NOTES: Record<string, string> = {
  greenhouse: `Detected ATS target (greenhouse). Discovery association allowed. Submission authorization pending separate platform policy review.`,
  lever: `Detected ATS target (lever). Discovery association allowed. Submission authorization pending separate platform policy review.`,
  workday: `Detected ATS target (workday). Discovery association allowed. Submission authorization pending separate platform policy review.`,
  ashby: `Detected ATS target (ashby). Discovery association allowed. Submission authorization pending separate platform policy review.`,
  workable: `Detected ATS target (workable). Discovery association allowed. Submission authorization pending separate platform policy review.`,
  smartrecruiters: `Detected ATS target (smartrecruiters). Discovery association allowed. Submission authorization pending separate platform policy review.`,
};

export function targetPolicyNotes(platform: string): string {
  return ATS_TARGET_POLICY_NOTES[platform] ?? ATS_TARGET_DEFAULT_POLICY_NOTE;
}