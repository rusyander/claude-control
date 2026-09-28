import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { ruleAssistantSpec } from './ruleAssistant';

const spec = ruleAssistantSpec();

describe('помощник формы правила', () => {
  it('заголовок и текст — оба в задании', () => {
    expect(Object.keys(assistantSchema(spec))).toEqual(['title', 'body']);
  });

  it('годное применяется, чужое поле названо', () => {
    const reading = readAssistantFields(spec, { title: 'T', body: 'B', groups: ['x'] });
    expect(reading.values).toEqual({ title: 'T', body: 'B' });
    expect(reading.missed).toEqual([{ field: 'groups', reason: 'unknown-field' }]);
  });

  it('текст не того вида не применяется', () => {
    const reading = readAssistantFields(spec, { body: { text: 'B' } });
    expect(reading.values).toEqual({});
    expect(reading.missed[0]?.reason).toBe('wrong-type');
  });
});
