import { describe, expect, it } from 'vitest';
import { collapseWhitespace, normalizeText, slugify } from '../src/text.js';

describe('text utilities', () => {
  it('normalizes text deterministically', () => {
    expect(normalizeText('  Senior   React \n Developer \r\n')).toBe('senior react developer');
    expect(normalizeText('Senior React Developer')).toBe(normalizeText('senior   react developer'));
  });

  it('collapses whitespace without lowercasing', () => {
    expect(collapseWhitespace('  A   B\tC\n')).toBe('A B C');
  });

  it('slugifies accents and symbols', () => {
    expect(slugify('Développeur Sénior / Front-end')).toBe('developpeur-senior-front-end');
    expect(slugify('Software Engineering')).toBe('software-engineering');
  });
});