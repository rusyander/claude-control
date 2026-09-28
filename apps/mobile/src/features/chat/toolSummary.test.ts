import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from './toolSummary';

/** Строка вызова в ленте: о чём спрашивают и что делает субагент — без открытия. */
describe('summarizeToolInput', () => {
  it('вопрос агента — его первый вопрос', () => {
    const input = { questions: [{ question: 'Which stack?\nmore' }, { question: 'Second' }] };
    expect(summarizeToolInput(JSON.stringify(input))).toBe('Which stack? …');
  });

  it('субагент — описание, а не промпт', () => {
    const input = { description: 'Scan the repo', prompt: 'scan everything', subagent_type: 'x' };
    expect(summarizeToolInput(JSON.stringify(input))).toBe('Scan the repo');
  });

  it('команда важнее описания, пустой вопрос не мешает', () => {
    const input = { command: 'ls -la', description: 'List', questions: [{ question: ' ' }] };
    expect(summarizeToolInput(JSON.stringify(input))).toBe('ls -la');
  });
});
