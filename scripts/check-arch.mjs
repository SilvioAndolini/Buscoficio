#!/usr/bin/env node
/**
 * Architecture boundary checker.
 * Source of truth: docs/arquitectura/11-estructura-repositorio.md (Fase 0.1).
 *
 * Rules:
 *  - `core` and `shared` cannot import project packages (only zod / node:crypto).
 *  - Adapter/service packages can only import allowed project packages.
 *  - No package may import an application (`@job-system/api|worker|web|browser-worker`).
 *  - Relative imports must not escape the package directory.
 *
 * Runs a self-test (known violations) before checking the real workspace.
 * Usage: node scripts/check-arch.mjs
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLICATION_PACKAGES = ['@job-system/api', '@job-system/worker', '@job-system/web', '@job-system/browser-worker'];

const PACKAGE_RULES = {
  'packages/shared': { allowProject: [], allowExternals: ['zod', 'node:crypto'] },
  'packages/core': { allowProject: [], allowExternals: ['zod', 'node:crypto'] },
  'packages/observability': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/database': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/storage': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/job-sources': {
    allowProject: ['@job-system/core', '@job-system/shared'],
    allowExternals: ['zod', 'node:crypto'],
  },
  'packages/matching': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/ai': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/documents': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/application-engine': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'packages/browser-automation': { allowProject: ['@job-system/core', '@job-system/shared'] },
  'apps/web': { allowProject: [] },
  'apps/api': { allowProject: 'any' },
  'apps/worker': { allowProject: 'any' },
  'apps/browser-worker': { allowProject: 'any' },
};

const IMPORT_RE =
  /(?:from\s+['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function projectDependency(spec) {
  if (!spec.startsWith('@job-system/')) return null;
  const parts = spec.split('/');
  return `${parts[0]}/${parts[1]}`;
}

export function checkWorkspace(root) {
  const violations = [];
  const checkPackage = (pkgPath, rules) => {
    const pkgDir = join(root, pkgPath);
    const files = [...walk(join(pkgDir, 'src')), ...walk(join(pkgDir, 'test'))];
    for (const file of files) {
      const isTest = file.includes(`${sep}test${sep}`) || file.endsWith('.test.ts');
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (!spec) continue;
        const rel = `${pkgPath}/${file.slice(pkgDir.length + 1).split(sep).join('/')}`;
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          if (resolved !== pkgDir && !resolved.startsWith(pkgDir + sep)) {
            violations.push({ file: rel, spec, rule: 'relative import escapes package directory' });
          }
          continue;
        }
        const dep = projectDependency(spec);
        if (dep) {
          if (APPLICATION_PACKAGES.includes(dep) && !pkgPath.startsWith('apps/')) {
            violations.push({ file: rel, spec, rule: 'cannot import an application package' });
            continue;
          }
          if (rules.allowProject === 'any') continue;
          if (!rules.allowProject.includes(dep)) {
            violations.push({
              file: rel,
              spec,
              rule: `project dependency not allowed (allowed: ${rules.allowProject.join(', ') || 'none'})`,
            });
          }
          continue;
        }
        if (!isTest && rules.allowExternals) {
          const base = spec.startsWith('node:') ? spec : spec.split('/')[0];
          if (!rules.allowExternals.includes(spec) && !rules.allowExternals.includes(base)) {
            violations.push({
              file: rel,
              spec,
              rule: `external dependency not allowed (allowed: ${rules.allowExternals.join(', ')})`,
            });
          }
        }
      }
    }
  };

  for (const [pkgPath, rules] of Object.entries(PACKAGE_RULES)) {
    checkPackage(pkgPath, rules);
  }
  return violations;
}

function selfTest() {
  const tmp = join(ROOT, 'scripts', '.archselftest');
  rmSync(tmp, { recursive: true, force: true });
  const write = (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  };
  write(join(tmp, 'packages/core/src/bad.ts'), "import Fastify from 'fastify';\n");
  write(join(tmp, 'packages/core/src/bad2.ts'), "import { x } from '@job-system/shared';\n");
  write(join(tmp, 'packages/core/src/bad3.ts'), "import { y } from '@job-system/api';\n");
  write(join(tmp, 'apps/web/src/bad.ts'), "import { y } from '@job-system/core';\n");
  write(join(tmp, 'packages/database/src/escape.ts'), "import { z } from '../../outside';\n");
  write(join(tmp, 'packages/database/src/ok.ts'), "import { z } from 'zod';\n");

  const violations = checkWorkspace(tmp);
  const expectedRules = [
    'external dependency not allowed',
    'project dependency not allowed',
    'cannot import an application package',
    'relative import escapes package directory',
  ];
  const missing = expectedRules.filter((r) => !violations.some((v) => v.rule.startsWith(r)));
  rmSync(tmp, { recursive: true, force: true });
  if (missing.length > 0) {
    throw new Error(`self-test failed: no violation detected for: ${missing.join(' | ')}`);
  }
  if (violations.some((v) => v.file.endsWith('packages/database/src/ok.ts'))) {
    throw new Error('self-test failed: false positive on allowed zod import');
  }
  process.stdout.write('arch self-test: OK (4/4 violation types detected)\n');
}

selfTest();
const violations = checkWorkspace(ROOT);
if (violations.length > 0) {
  process.stderr.write(`Architecture violations (${violations.length}):\n`);
  for (const v of violations) process.stderr.write(`  ${v.file}: '${v.spec}' -> ${v.rule}\n`);
  process.exit(1);
}
process.stdout.write('arch check: OK\n');