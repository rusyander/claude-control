import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { permissionAssistantSpec } from './permissionAssistant';

const spec = permissionAssistantSpec(['allow', 'ask', 'deny']);

describe('помощник формы права', () => {
  it('решение — одно из трёх, с пояснением', () => {
    expect(assistantSchema(spec).decision).toContain('"deny" (forbid)');
  });

  it('годное применяется', () => {
    const reading = readAssistantFields(spec, { pattern: 'Bash(git push:*)', decision: 'deny' });
    expect(reading.values).toEqual({ pattern: 'Bash(git push:*)', decision: 'deny' });
  });

  it('неизвестное решение отброшено и названо', () => {
    const reading = readAssistantFields(spec, { decision: 'block' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'decision', reason: 'unknown-value', values: ['block'] },
    ]);
  });

  it('шаблон не того вида не применяется', () => {
    expect(readAssistantFields(spec, { pattern: null }).missed[0]?.reason).toBe('wrong-type');
  });
});
