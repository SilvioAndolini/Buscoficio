import { ConflictError, type ApplicationActor, type ApplicationMode, type ApplicationStatus } from '@job-system/core';

/**
 * Approved application state machine (architecture doc 03 §4). Pure: no I/O,
 * no clock, no repository. Phase 4 executes the preparation segment; future
 * transitions exist with their guards so they can never be bypassed.
 */

export interface TransitionContext {
  actor: ApplicationActor;
  /** Complete preparation snapshot (form inspected + fields mapped) — Phase 5. */
  preparationSnapshotComplete?: boolean;
  /** Ledger claimed + preflight OK — Phase 5/6. */
  submissionAuthorized?: boolean;
  /** Retry allowed after FAILED (policy) — future. */
  retryAllowed?: boolean;
  /** Application mode; AUTO preparation is Phase 6. */
  mode?: ApplicationMode;
  /** Human reason for REQUIRES_HUMAN_ACTION / its resolution. */
  reason?: string;
}

export interface TransitionCheck {
  allowed: boolean;
  reason?: string;
}

function deny(reason: string): TransitionCheck {
  return { allowed: false, reason };
}

const ALLOW: TransitionCheck = { allowed: true };

const ALLOWED: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  DISCOVERED: ['FILTERED', 'ARCHIVED'],
  FILTERED: ['SHORTLISTED', 'ARCHIVED'],
  SHORTLISTED: ['PREPARING', 'ARCHIVED'],
  PREPARING: ['READY_FOR_REVIEW', 'REQUIRES_HUMAN_ACTION', 'ARCHIVED'],
  READY_FOR_REVIEW: ['APPROVED', 'ARCHIVED'],
  APPROVED: ['SUBMITTING', 'ARCHIVED'],
  SUBMITTING: ['PREPARING', 'SUBMITTED', 'FAILED', 'REQUIRES_HUMAN_ACTION', 'ARCHIVED'],
  SUBMITTED: ['REJECTED', 'INTERVIEW', 'OFFER', 'ARCHIVED'],
  REJECTED: ['ARCHIVED'],
  INTERVIEW: ['ARCHIVED'],
  OFFER: ['ARCHIVED'],
  FAILED: ['PREPARING', 'ARCHIVED'],
  REQUIRES_HUMAN_ACTION: ['PREPARING', 'APPROVED', 'ARCHIVED'],
  ARCHIVED: [],
};

/** True when the application still occupies the active slot (invariant A1). */
export function isActiveStatus(status: ApplicationStatus): boolean {
  return status !== 'ARCHIVED' && status !== 'REJECTED';
}

function checkGuard(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context: TransitionContext,
): TransitionCheck {
  const isArchive = to === 'ARCHIVED';
  if (isArchive) {
    if (context.actor === 'user') return ALLOW;
    // System may discard only pre-preparation noise; never an application that
    // the user is preparing/reviewing.
    if (context.actor === 'system' && (from === 'DISCOVERED' || from === 'FILTERED')) return ALLOW;
    return deny(`actor '${context.actor}' cannot archive from ${from}`);
  }

  switch (`${from}->${to}`) {
    case 'DISCOVERED->FILTERED':
    case 'FILTERED->SHORTLISTED':
      return context.actor === 'system' ? ALLOW : deny(`actor '${context.actor}' cannot run '${from}->${to}'`);

    case 'SHORTLISTED->PREPARING':
      if (context.actor !== 'system') return deny(`actor '${context.actor}' cannot start preparation`);
      if (context.mode === 'auto') return deny('AUTO preparation belongs to Phase 6 (not available)');
      if (context.mode !== undefined && context.mode !== 'manual' && context.mode !== 'assisted') {
        return deny(`mode '${context.mode}' cannot start preparation`);
      }
      return ALLOW;

    case 'PREPARING->READY_FOR_REVIEW':
      if (context.actor !== 'system') return deny(`actor '${context.actor}' cannot mark ready for review`);
      if (context.preparationSnapshotComplete !== true) {
        return deny(
          'preparationSnapshot is not complete: inspecting the real form requires SubmissionPort (Phase 5)',
        );
      }
      return ALLOW;

    case 'PREPARING->REQUIRES_HUMAN_ACTION':
      if (context.actor !== 'system') return deny(`actor '${context.actor}' cannot raise human action`);
      if (context.reason === undefined || context.reason.trim().length === 0) {
        return deny('requiresHumanReason is mandatory');
      }
      return ALLOW;

    case 'READY_FOR_REVIEW->APPROVED':
      if (context.actor === 'user') return ALLOW;
      // System approval requires AUTO guards (Phase 6): snapshot + authorization.
      if (context.preparationSnapshotComplete !== true) return deny('system approval requires a complete snapshot');
      return ALLOW;

    case 'REQUIRES_HUMAN_ACTION->PREPARING':
      if (context.actor !== 'user') return deny('only a human can resolve REQUIRES_HUMAN_ACTION');
      if (context.reason === undefined || context.reason.trim().length === 0) {
        return deny('resolution reason is mandatory');
      }
      return ALLOW;

    case 'REQUIRES_HUMAN_ACTION->APPROVED':
      if (context.actor !== 'user') return deny('only a human can resolve REQUIRES_HUMAN_ACTION');
      if (context.preparationSnapshotComplete !== true) {
        return deny('cannot approve without a complete preparationSnapshot (Phase 5)');
      }
      return ALLOW;

    case 'APPROVED->SUBMITTING':
      if (context.actor !== 'system') return deny(`actor '${context.actor}' cannot submit`);
      if (context.submissionAuthorized !== true) {
        return deny('submission requires the ledger claim + preflight (Phase 5)');
      }
      return ALLOW;

    case 'SUBMITTING->PREPARING':
    case 'SUBMITTING->SUBMITTED':
    case 'SUBMITTING->FAILED':
    case 'SUBMITTING->REQUIRES_HUMAN_ACTION':
      return context.actor === 'system' ? ALLOW : deny(`actor '${context.actor}' cannot run '${from}->${to}'`);

    case 'SUBMITTED->REJECTED':
    case 'SUBMITTED->INTERVIEW':
    case 'SUBMITTED->OFFER':
      return context.actor === 'user' ? ALLOW : deny(`actor '${context.actor}' cannot run '${from}->${to}'`);

    case 'FAILED->PREPARING':
      if (context.actor !== 'system') return deny(`actor '${context.actor}' cannot retry`);
      if (context.retryAllowed !== true) return deny('retry after FAILED is not allowed by policy');
      return ALLOW;

    default:
      return deny(`transition ${from}->${to} is not part of the approved state machine`);
  }
}

/** Pure transition check; never throws (tests and UI can preview a decision). */
export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context: TransitionContext,
): TransitionCheck {
  if (!ALLOWED[from].includes(to)) {
    return deny(`transition ${from}->${to} is not part of the approved state machine`);
  }
  return checkGuard(from, to, context);
}

/** Command-time assertion: illegal transition ⇒ typed ConflictError. */
export function assertTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context: TransitionContext,
): void {
  const check = canTransition(from, to, context);
  if (!check.allowed) {
    throw new ConflictError(`Application transition ${from}->${to} denied: ${check.reason ?? 'unknown'}`, {
      context: {
        from,
        to,
        actor: context.actor,
        ...(context.mode === undefined ? {} : { mode: context.mode }),
      },
    });
  }
}
