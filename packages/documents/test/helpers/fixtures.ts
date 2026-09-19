import type {
  ProfileFactsSource,
  ProfileFactsView,
  TextGenerationPort,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
} from '@job-system/core';
import { AiError } from '@job-system/core';
import { buildProfileFactsView } from '../../src/facts.js';

export const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';

export function buildFactsSource(overrides: Partial<ProfileFactsSource> = {}): ProfileFactsSource {
  const base: ProfileFactsSource = {
    profile: {
      id: CANDIDATE_ID,
      fullName: 'Ada Lovelace',
      headline: 'Software Engineer',
      salaryMin: 60_000,
      salaryMax: 80_000,
      salaryCurrency: 'EUR',
    },
    skills: [
      { id: '10000000-0000-4000-8000-000000000001', name: 'React', aliases: ['React.js'], level: 'expert', years: 5 },
      { id: '10000000-0000-4000-8000-000000000002', name: 'TypeScript', aliases: [], level: 'advanced', years: null },
    ],
    experiences: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        company: 'Acme Corp',
        title: 'Senior Developer',
        startDate: new Date('2018-01-01T00:00:00Z'),
        endDate: new Date('2024-01-01T00:00:00Z'),
        skills: ['React', 'TypeScript'],
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        company: 'Globex',
        title: 'Developer',
        startDate: new Date('2016-01-01T00:00:00Z'),
        endDate: new Date('2017-06-01T00:00:00Z'),
        skills: ['React'],
      },
    ],
    education: [
      {
        id: '30000000-0000-4000-8000-000000000001',
        institution: 'University of London',
        degree: 'BSc Computer Science',
        field: 'Computer Science',
        startDate: new Date('2012-09-01T00:00:00Z'),
        endDate: new Date('2015-06-01T00:00:00Z'),
        status: 'completed',
      },
    ],
    languages: [
      { id: '40000000-0000-4000-8000-000000000001', language: 'English', level: 'C1' },
    ],
  };
  return { ...base, ...overrides };
}

export function buildFacts(overrides: Partial<ProfileFactsSource> = {}): ProfileFactsView {
  return buildProfileFactsView(buildFactsSource(overrides), { includeSalary: true });
}

export type ScriptedResponse =
  | { kind: 'structured'; value: unknown }
  | { kind: 'error'; error: Error };

/** Minimal scripted TextGenerationPort for documents tests (no ai import). */
export function buildScriptedProvider(script: ScriptedResponse[]): TextGenerationPort & {
  calls: number;
} {
  let calls = 0;
  const provider: TextGenerationPort & { calls: number } = {
    provider: 'scripted',
    model: 'scripted-v1',
    get calls() {
      return calls;
    },
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      calls += 1;
      return {
        text: 'text',
        provider: 'scripted',
        model: 'scripted-v1',
        promptVersion: request.promptVersion,
        inputHash: request.inputHash,
        tokensIn: null,
        tokensOut: null,
        latencyMs: 1,
        finishReason: 'stop',
      };
    },
    async completeStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      calls += 1;
      const next = script.shift();
      if (!next) throw new AiError('script exhausted');
      if (next.kind === 'error') throw next.error;
      const parsed = request.schema.safeParse(next.value);
      if (!parsed.success) {
        throw new AiError('scripted structured output failed schema validation', {
          context: { schemaName: request.schemaName, invalidOutput: true },
        });
      }
      return {
        text: JSON.stringify(parsed.data),
        value: parsed.data,
        provider: 'scripted',
        model: 'scripted-v1',
        promptVersion: request.promptVersion,
        inputHash: request.inputHash,
        tokensIn: 10,
        tokensOut: 20,
        latencyMs: 5,
        finishReason: 'stop',
      };
    },
  };
  return provider;
}

export const JOB_VIEW = {
  id: '00000000-0000-4000-8000-0000000000aa',
  title: 'Senior React Developer',
  company: 'Acme Corp',
  description: 'Build internal tools with React.',
  location: 'Remote (EU)',
  remoteType: 'remote',
  employmentType: 'full_time',
  requiredSkills: ['React'],
  preferredSkills: ['TypeScript'],
  languageRequirements: ['English B2'],
};
