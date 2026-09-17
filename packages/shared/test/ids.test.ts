import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('generates RFC 9562 v7 shaped ids', () => {
    expect(uuidv7()).toMatch(UUID_V7_RE);
  });

  it('encodes the timestamp prefix (time-ordered)', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(ids.size).toBe(500);
  });

  it('rejects invalid timestamps', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(Number.NaN)).toThrow(RangeError);
  });
});