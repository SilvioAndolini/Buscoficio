import { PolicyDeniedError, type ApplicationMode } from '@job-system/core';

/**
 * Phase 4 policy slice (architecture doc 03 §10, task §104). Deliberately small:
 * the full versioned policy engine (global + per-candidate, quotas, AUTO
 * allowlists) is Phase 6. No constant is scattered outside this module.
 */

/** Max factual repair attempts after the first generation (doc 08 §2). */
export const MAX_FACTUAL_REPAIR_ATTEMPTS = 1;

/** Modes that may create an application through the Phase 4 API. */
export const PHASE4_APPLICATION_MODES: readonly ApplicationMode[] = ['manual', 'assisted'];

export const DEFAULT_REAPPLICATION_COOLDOWN_DAYS = 30;

export interface ApplicationPreparationPolicy {
  /** Base version string (e.g. `application-prep-v1`). */
  version: string;
  reapplicationCooldownDays: number;
  maxFactualRepairAttempts: number;
}

/**
 * `policyVersion` persisted on every Application. The cooldown participates so
 * a policy change is visible on new applications without touching history.
 */
export function buildPolicyVersion(baseVersion: string, cooldownDays: number): string {
  return `${baseVersion}:cooldown=${cooldownDays}d`;
}

export function isCooldownSatisfied(input: {
  lastTransitionAt: Date;
  now: Date;
  cooldownDays: number;
}): boolean {
  const elapsedMs = input.now.getTime() - input.lastTransitionAt.getTime();
  return elapsedMs >= input.cooldownDays * 24 * 60 * 60 * 1000;
}

export function assertPhase4Mode(mode: ApplicationMode): void {
  if (!PHASE4_APPLICATION_MODES.includes(mode)) {
    throw new PolicyDeniedError(
      `mode '${mode}' is not available in Phase 4: creating an application via API only supports manual|assisted (AUTO belongs to Phase 6)`,
      { context: { mode, allowedModes: PHASE4_APPLICATION_MODES } },
    );
  }
}
