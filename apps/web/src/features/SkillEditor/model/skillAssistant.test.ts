import { describe, expect, it } from 'vitest';
import { assistantSchema, readAssistantFields } from '@shared/lib/assistant-fields';
import { skillAssistantSpec } from './skillAssistant';

const templates = [
  { id: 'modular', title: 'Modular' },
  { id: 'with-examples', title: 'With examples' },
];

describe('помощник формы скилла', () => {
  it('новый скилл: имя и заготовка структуры открыты, переименование — нет', () => {
    const spec = skillAssistantSpec({ created: false, editing: false, templates });
    const schema = assistantSchema(spec);
    expect(Object.keys(schema)).toEqual(['name', 'description', 'body', 'structureTemplate']);
    expect(schema.structureTemplate).toContain('"modular" (Modular)');
    const reading = readAssistantFields(spec, { name: 'a', structureTemplate: 'With examples' });
    expect(reading.values).toEqual({ name: 'a', structureTemplate: 'with-examples' });
  });

  it('несуществующая заготовка отброшена и названа', () => {
    const spec = skillAssistantSpec({ created: false, editing: false, templates });
    const reading = readAssistantFields(spec, { structureTemplate: 'mega' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'structureTemplate', reason: 'unknown-value', values: ['mega'] },
    ]);
  });

  it('созданный скилл: имя и заготовка закрыты, переименование открыто', () => {
    const spec = skillAssistantSpec({ created: true, editing: true, templates });
    expect(Object.keys(assistantSchema(spec))).toEqual(['description', 'body', 'renameTo']);
    const reading = readAssistantFields(spec, { name: 'b', renameTo: 'b', body: 42 });
    expect(reading.values).toEqual({ renameTo: 'b', body: '42' });
    expect(reading.missed).toEqual([{ field: 'name', reason: 'locked' }]);
  });

  it('описание не того вида не применяется', () => {
    const spec = skillAssistantSpec({ created: false, editing: false, templates });
    expect(readAssistantFields(spec, { description: ['x'] }).missed[0]?.reason).toBe('wrong-type');
  });
});
