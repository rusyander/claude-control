import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { hookAssistantSpec } from './hookAssistant';

/** Помощник хука: событие и шаблон — из списков, фильтры — списком, таймаут — числом. */
const spec = hookAssistantSpec();

describe('помощник формы хука', () => {
  const schema = assistantSchema(spec);

  it('каждое поле конструктора в задании, таймаут тоже', () => {
    expect(Object.keys(schema)).toEqual([
      'event',
      'matchers',
      'scriptName',
      'template',
      'description',
      'message',
      'guardPatterns',
      'command',
      'timeout',
    ]);
    expect(schema.event).toContain('"PostToolUse"');
    expect(schema.template).toContain('"guard" (a block)');
    expect(schema.matchers).toContain('"WebFetch"');
    expect(schema.timeout).toContain('an integer from 1');
  });

  it('годное применяется', () => {
    const reading = readAssistantFields(spec, {
      event: 'posttooluse',
      matchers: ['Bash', 'mcp__gitlab__.*'],
      template: 'shell',
      timeout: 30,
    });
    expect(reading.values).toEqual({
      event: 'PostToolUse',
      matchers: ['Bash', 'mcp__gitlab__.*'],
      template: 'shell',
      timeout: 30,
    });
    expect(reading.missed).toEqual([]);
  });

  it('несуществующее событие и шаблон отброшены и названы', () => {
    const reading = readAssistantFields(spec, { event: 'OnSave', template: 'python' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'event', reason: 'unknown-value', values: ['OnSave'] },
      { field: 'template', reason: 'unknown-value', values: ['python'] },
    ]);
  });

  it('не того вида — не применено: фильтры строкой, таймаут дробью', () => {
    const reading = readAssistantFields(spec, { matchers: 'Bash,Write', timeout: 2.5 });
    expect(reading.values).toEqual({});
    expect(reading.missed.map((miss) => miss.reason)).toEqual(['wrong-type', 'wrong-type']);
  });

  it('null сбрасывает таймаут к умолчанию', () => {
    expect(readAssistantFields(spec, { timeout: null }).values).toEqual({ timeout: null });
  });
});
