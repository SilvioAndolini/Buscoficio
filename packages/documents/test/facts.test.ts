import { describe, expect, it } from 'vitest';
import { buildProfileFactsView } from '../src/facts.js';
import { buildFactsSource } from './helpers/fixtures.js';

describe('ProfileFactsView (Phase 4)', () => {
  it('excludes email, phone, address and full CV files by default', () => {
    const facts = buildProfileFactsView(buildFactsSource(), { includeSalary: false });
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('locationCity');
    expect(facts.salary).toBeNull();
    expect(facts.displayName).toBe('Ada Lovelace');
  });

  it('includes salary only when explicitly requested', () => {
    const withSalary = buildProfileFactsView(buildFactsSource(), { includeSalary: true });
    expect(withSalary.salary).toEqual({ min: 60_000, max: 80_000, currency: 'EUR' });
  });

  it('is deterministic regardless of input ordering', () => {
    const source = buildFactsSource();
    const reordered = {
      ...source,
      skills: [...source.skills].reverse(),
      experiences: [...source.experiences].reverse(),
      languages: [...source.languages].reverse(),
    };
    expect(JSON.stringify(buildProfileFactsView(reordered))).toBe(
      JSON.stringify(buildProfileFactsView(source)),
    );
  });
});
