import type { ProjectTestMutationCase } from '@agentdeck/contracts';

export const CASE_WORD = {
  failed: 'testsE2e.mutation.caseCaught',
  blocked: 'testsE2e.mutation.caseCaught',
  passed: 'testsE2e.mutation.caseMissed',
} as const;

export function caseWord(item: ProjectTestMutationCase): string {
  return item.status in CASE_WORD
    ? CASE_WORD[item.status as keyof typeof CASE_WORD]
    : 'testsE2e.mutation.caseNoResult';
}
