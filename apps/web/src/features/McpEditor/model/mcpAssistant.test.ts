import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { mcpAssistantSpec } from './mcpAssistant';

const spec = mcpAssistantSpec(['stdio', 'sse', 'http']);

describe('помощник формы MCP-сервера', () => {
  it('транспорт — из известных, остальные поля — тексты', () => {
    const schema = assistantSchema(spec);
    expect(Object.keys(schema)).toEqual([
      'name',
      'transport',
      'command',
      'args',
      'url',
      'envText',
      'headersText',
    ]);
    expect(schema.transport).toContain('"sse"');
  });

  it('годное применяется', () => {
    const reading = readAssistantFields(spec, { transport: 'http', url: 'http://x' });
    expect(reading.values).toEqual({ transport: 'http', url: 'http://x' });
  });

  it('неизвестный транспорт отброшен и назван', () => {
    const reading = readAssistantFields(spec, { transport: 'websocket' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'transport', reason: 'unknown-value', values: ['websocket'] },
    ]);
  });

  it('аргументы списком — не того вида, не применены', () => {
    const reading = readAssistantFields(spec, { args: ['-y', 'pkg'] });
    expect(reading.values).toEqual({});
    expect(reading.missed[0]?.reason).toBe('wrong-type');
  });
});
