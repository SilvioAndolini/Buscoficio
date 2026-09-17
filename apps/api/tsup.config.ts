import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Bundle only workspace packages; every node_modules dependency (pino, pg,
  // drizzle-orm, fastify, ...) stays external to avoid CJS-in-ESM issues.
  noExternal: [/^@job-system\//],
  external: [/^(?!@job-system\/)(?!\.)(?!\/)/],
});