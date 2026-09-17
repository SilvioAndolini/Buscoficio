import { sha256Hex } from '@job-system/core';

const password = process.argv[2];
if (!password) {
  process.stderr.write('Usage: pnpm --filter @job-system/api hash-password "<password>"\n');
  process.exit(1);
}
process.stdout.write(`${sha256Hex(password)}\n`);