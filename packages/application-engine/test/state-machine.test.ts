import { describe, expect, it } from 'vitest';
import { ConflictError, type ApplicationStatus } from '@job-system/core';
import { assertTransition, canTransition, isActiveStatus } from '../src/state-machine.js';

describe('application state machine (Phase 4)', () => {
  it('allows the Phase 4 preparation path with the approved actors', () => {
    expect(canTransition('DISCOVERED', 'FILTERED', { actor: 'system' }).allowed).toBe(true);
    expect(canTransition('FILTERED', 'SHORTLISTED', { actor: 'system' }).allowed).toBe(true);
    expect(canTransition('SHORTLISTED', 'PREPARING', { actor: 'system', mode: 'assisted' }).allowed).toBe(true);
    expect(canTransition('SHORTLISTED', 'PREPARING', { actor: 'system', mode: 'manual' }).allowed).toBe(true);
    expect(
      canTransition('PREPARING', 'REQUIRES_HUMAN_ACTION', { actor: 'system', reason: 'claims rejected' })
        .allowed,
    ).toBe(true);
    expect(
      canTransition('REQUIRES_HUMAN_ACTION', 'PREPARING', { actor: 'user', reason: 'fixed profile' })
        .allowed,
    ).toBe(true);
  });

  it('denies READY_FOR_REVIEW without a complete preparationSnapshot', () => {
    const denied = canTransition('PREPARING', 'READY_FOR_REVIEW', { actor: 'system' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/preparationSnapshot/);

    const deniedPartial = canTransition('PREPARING', 'READY_FOR_REVIEW', {
      actor: 'system',
      preparationSnapshotComplete: false,
    });
    expect(deniedPartial.allowed).toBe(false);

    const allowed = canTransition('PREPARING', 'READY_FOR_REVIEW', {
      actor: 'system',
      preparationSnapshotComplete: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('denies APPROVED without a complete snapshot through the human-action route', () => {
    expect(canTransition('REQUIRES_HUMAN_ACTION', 'APPROVED', { actor: 'user' }).allowed).toBe(false);
    expect(
      canTransition('REQUIRES_HUMAN_ACTION', 'APPROVED', {
        actor: 'user',
        preparationSnapshotComplete: true,
      }).allowed,
    ).toBe(true);
  });

  it('denies submission without ledger authorization', () => {
    expect(canTransition('APPROVED', 'SUBMITTING', { actor: 'system' }).allowed).toBe(false);
    expect(
      canTransition('APPROVED', 'SUBMITTING', { actor: 'system', submissionAuthorized: true }).allowed,
    ).toBe(true);
  });

  it('denies AUTO preparation (Phase 6) and wrong actors', () => {
    expect(canTransition('SHORTLISTED', 'PREPARING', { actor: 'system', mode: 'auto' }).allowed).toBe(false);
    expect(canTransition('DISCOVERED', 'FILTERED', { actor: 'user' }).allowed).toBe(false);
    expect(canTransition('PREPARING', 'REQUIRES_HUMAN_ACTION', { actor: 'system' }).allowed).toBe(false);
    expect(canTransition('REQUIRES_HUMAN_ACTION', 'PREPARING', { actor: 'user' }).allowed).toBe(false);
    expect(canTransition('SUBMITTED', 'REJECTED', { actor: 'system' }).allowed).toBe(false);
    expect(canTransition('SUBMITTED', 'REJECTED', { actor: 'user' }).allowed).toBe(true);
  });

  it('requires retry authorization after FAILED', () => {
    expect(canTransition('FAILED', 'PREPARING', { actor: 'system' }).allowed).toBe(false);
    expect(canTransition('FAILED', 'PREPARING', { actor: 'system', retryAllowed: true }).allowed).toBe(true);
  });

  it('allows user archive from any state and system archive only for pre-preparation noise', () => {
    const statuses: ApplicationStatus[] = [
      'DISCOVERED',
      'FILTERED',
      'SHORTLISTED',
      'PREPARING',
      'READY_FOR_REVIEW',
      'APPROVED',
      'SUBMITTING',
      'SUBMITTED',
      'REJECTED',
      'INTERVIEW',
      'OFFER',
      'FAILED',
      'REQUIRES_HUMAN_ACTION',
    ];
    for (const status of statuses) {
      expect(canTransition(status, 'ARCHIVED', { actor: 'user' }).allowed).toBe(true);
      expect(canTransition(status, 'ARCHIVED', { actor: 'system' }).allowed).toBe(
        status === 'DISCOVERED' || status === 'FILTERED',
      );
    }
    expect(canTransition('ARCHIVED', 'PREPARING', { actor: 'user' }).allowed).toBe(false);
  });

  it('rejects transitions that are not part of the approved machine', () => {
    expect(canTransition('DISCOVERED', 'PREPARING', { actor: 'system' }).allowed).toBe(false);
    expect(canTransition('SHORTLISTED', 'APPROVED', { actor: 'user' }).allowed).toBe(false);
    expect(canTransition('PREPARING', 'SUBMITTED', { actor: 'system' }).allowed).toBe(false);
  });

  it('throws a typed ConflictError through assertTransition', () => {
    expect(() => assertTransition('PREPARING', 'READY_FOR_REVIEW', { actor: 'system' })).toThrow(
      ConflictError,
    );
    try {
      assertTransition('PREPARING', 'READY_FOR_REVIEW', { actor: 'system' });
    } catch (error) {
      expect((error as ConflictError).context).toMatchObject({
        from: 'PREPARING',
        to: 'READY_FOR_REVIEW',
      });
    }
  });

  it('defines active statuses for the partial unique invariant', () => {
    expect(isActiveStatus('PREPARING')).toBe(true);
    expect(isActiveStatus('REJECTED')).toBe(false);
    expect(isActiveStatus('ARCHIVED')).toBe(false);
  });
});
