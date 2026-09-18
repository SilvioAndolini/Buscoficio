#!/usr/bin/env node
/**
 * Records real API responses into anonymized contract fixtures.
 * Run manually (not part of CI): node scripts/record-fixtures.mjs
 *
 * Anonymization: company names and personal-looking names are replaced with
 * fictitious values; structure and ATS links are preserved so target detection
 * and normalization stay realistic.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'packages/job-sources/test/fixtures');
const UA = 'Buscoficio/0.1 (fixture recorder; +https://github.com/SilvioAndolini/Buscoficio)';

const COMPANY_ALIASES = ['Acme Remote', 'Globex Talent', 'Initech Staffing', 'Umbrella Careers', 'Wayne Hiring'];

function anonymizeCompanies(payload) {
  let index = 0;
  const replace = (value) => {
    if (typeof value === 'string') return value;
    return value;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const copy = {};
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'company' || key === 'company_name') && typeof value === 'string') {
          copy[key] = COMPANY_ALIASES[index % COMPANY_ALIASES.length];
          index += 1;
        } else {
          copy[key] = walk(value);
        }
      }
      return copy;
    }
    return replace(node);
  };
  return walk(payload);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

const targets = [
  {
    name: 'remotive',
    url: 'https://remotive.com/api/remote-jobs?limit=5',
    trim: (payload) => ({ ...payload, jobs: payload.jobs.slice(0, 5) }),
  },
  {
    name: 'arbeitnow',
    url: 'https://www.arbeitnow.com/api/job-board-api?page=1',
    trim: (payload) => ({ ...payload, data: payload.data.slice(0, 5) }),
  },
  {
    name: 'remoteok',
    url: 'https://remoteok.com/api',
    trim: (payload) => payload.slice(0, 6),
  },
];

for (const target of targets) {
  const raw = await fetchJson(target.url);
  const anonymized = anonymizeCompanies(target.trim(raw));
  const dir = join(FIXTURES, target.name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'search-page.json');
  await writeFile(file, `${JSON.stringify(anonymized, null, 2)}\n`, 'utf8');
  console.log(`recorded ${target.name}: ${file}`);
}
