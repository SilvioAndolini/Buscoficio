import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/smoke.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Bundle only workspace packages; node_modules dependencies stay external.
  noExternal: [/^@job-system\//],
  external: [/^(?!@job-system\/)(?!\.)(?!\/)/],
});