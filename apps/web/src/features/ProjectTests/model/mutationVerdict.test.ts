import { describe, expect, it } from 'vitest';
import type { ProjectTestMutationCase } from '@agentdeck/contracts';
import { mutationVerdict } from './mutationVerdict';

const item = (status: ProjectTestMutationCase['status']): ProjectTestMutationCase => ({
  groupId: 'g',
  caseId: `c-${status}`,
  title: status,
  automationFile: 'a.spec.ts',
  status,
});

describe('итог проверки поломкой (Ф10)', () => {
  it('покраснел хоть один — поймали; только зелёные — не защищён', () => {
    expect(mutationVerdict({ cases: [item('failed'), item('passed')] })).toBe('caught');
    expect(mutationVerdict({ cases: [item('blocked')] })).toBe('caught');
    expect(mutationVerdict({ cases: [item('passed'), item('no-result')] })).toBe('unprotected');
  });

  it('отчёт не сказал ни про один кейс — «нет результата», а не «не защищён»', () => {
    expect(mutationVerdict({ cases: [item('no-result'), item('no-result')] })).toBe('noResult');
  });
});
