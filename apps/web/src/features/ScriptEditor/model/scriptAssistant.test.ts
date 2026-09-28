import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { scriptAssistantSpec } from './scriptAssistant';

describe('помощник формы скрипта', () => {
  it('о хуках говорит только там, где они есть', () => {
    expect(assistantSchema(scriptAssistantSpec({ hasHooks: true })).content).toContain('hooks');
    expect(assistantSchema(scriptAssistantSpec({ hasHooks: false })).content).not.toContain(
      'hooks',
    );
  });

  it('годное применяется, не того вида — нет', () => {
    const reading = readAssistantFields(scriptAssistantSpec({ hasHooks: true }), {
      name: 'a.mjs',
      content: ['line'],
    });
    expect(reading.values).toEqual({ name: 'a.mjs' });
    expect(reading.missed).toEqual([{ field: 'content', reason: 'wrong-type' }]);
  });
});
