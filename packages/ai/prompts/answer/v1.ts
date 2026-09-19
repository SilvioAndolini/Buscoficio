import type { ProfileFactsView, PromptPayload } from '@job-system/core';

/**
 * Versioned prompt for drafting an answer to a known question. Phase 4 only
 * reuses/validates answers through the answer bank; generation is available for
 * later phases and contract-tested here.
 */
export const ANSWER_PROMPT_VERSION = 'answer/v1';

const SYSTEM = `You draft short answers to application questions using ONLY the candidate facts.
Rules:
- Never invent facts; if the facts do not support an answer, say so and return an empty claims list.
- Output JSON: {"text": string, "claims": [{"claim": string, "kind": string, "value": object}]}.`;

export function buildAnswerPromptV1(input: {
  questionText: string;
  facts: ProfileFactsView;
}): PromptPayload {
  return {
    promptVersion: ANSWER_PROMPT_VERSION,
    system: SYSTEM,
    user: [
      'CANDIDATE FACTS:',
      JSON.stringify(input.facts, null, 2),
      '',
      `QUESTION: ${input.questionText}`,
      '',
      'Answer in at most 120 words using only the candidate facts. Return the JSON object described in the system instructions.',
    ].join('\n'),
  };
}
