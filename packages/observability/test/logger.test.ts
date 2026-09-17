import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createJobLogger, createLogger } from '../src/logger.js';

function capture(): { stream: DestinationStream; lines: string[] } {
  const lines: string[] = [];
  return { stream: { write: (line: string) => void lines.push(line) }, lines };
}

describe('logger redaction', () => {
  it('redacts sensitive fields at root and nested levels', () => {
    const { stream, lines } = capture();
    const log = createLogger({ level: 'info', stream });
    log.info(
      {
        password: 'p@ssw0rd',
        token: 'tok_123',
        email: 'candidate@example.com',
        phone: '+34 600 000 000',
        nested: { token: 'nested_tok', email: 'nested@example.com' },
        safe: 'visible',
      },
      'profile updated',
    );
    const output = lines.join('');
    expect(output).not.toContain('p@ssw0rd');
    expect(output).not.toContain('tok_123');
    expect(output).not.toContain('candidate@example.com');
    expect(output).not.toContain('nested@example.com');
    expect(output).not.toContain('600 000 000');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('visible');
  });

  it('propagates trace context into child loggers', () => {
    const { stream, lines } = capture();
    const log = createJobLogger(createLogger({ level: 'info', stream }), {
      correlationId: 'corr-1',
      jobId: 'job-1',
      sourceId: 'mock',
      applicationId: 'app-1',
    });
    log.info('processing');
    const record = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(record['correlationId']).toBe('corr-1');
    expect(record['jobId']).toBe('job-1');
    expect(record['sourceId']).toBe('mock');
    expect(record['applicationId']).toBe('app-1');
    expect(record['msg']).toBe('processing');
  });
});