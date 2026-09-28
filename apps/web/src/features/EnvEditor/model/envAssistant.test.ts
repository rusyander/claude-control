import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { envAssistantSpec } from './envAssistant';

describe('помощник формы переменной', () => {
  it('при создании файл выбирается из двух', () => {
    const spec = envAssistantSpec({ sourceLocked: false });
    expect(assistantSchema(spec).source).toContain('"settings"');
    const reading = readAssistantFields(spec, { key: 'A', source: 'settings', comment: 'c' });
    expect(reading.values).toEqual({ key: 'A', source: 'settings', comment: 'c' });
  });

  it('неизвестный файл отброшен и назван', () => {
    const reading = readAssistantFields(envAssistantSpec({ sourceLocked: false }), {
      source: '.env',
    });
    expect(reading.missed).toEqual([
      { field: 'source', reason: 'unknown-value', values: ['.env'] },
    ]);
  });

  it('при правке файл закрыт: модели не предлагается, присланное не применяется', () => {
    const spec = envAssistantSpec({ sourceLocked: true });
    expect(Object.keys(assistantSchema(spec))).toEqual(['key', 'value', 'comment']);
    const reading = readAssistantFields(spec, { source: 'settings', value: 'v' });
    expect(reading.values).toEqual({ value: 'v' });
    expect(reading.missed).toEqual([{ field: 'source', reason: 'locked' }]);
  });

  it('значение не того вида не применяется', () => {
    const reading = readAssistantFields(envAssistantSpec({ sourceLocked: false }), {
      key: ['A'],
    });
    expect(reading.values).toEqual({});
    expect(reading.missed[0]?.reason).toBe('wrong-type');
  });
});
