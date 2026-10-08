import { describe, expect, it } from 'vitest';
import { assistantSchema, MAX_LISTED_OPTIONS } from './assistant-fields';
import type { AssistantSpec } from './assistant-fields.types';
import { groupMisses } from './groupMisses';
import { readAssistantFields } from './readAssistantFields';

const SPEC = {
  name: { type: 'text', hint: 'Name' },
  color: {
    type: 'choice',
    hint: 'Color',
    options: [
      { value: 'red', label: 'Red colour' },
      { value: 'blue', label: 'Blue colour' },
    ],
  },
  members: {
    type: 'choices',
    hint: 'Members',
    options: [
      { value: 'rule:a', label: 'Rule A' },
      { value: 'skill:b', label: 'Skill B' },
    ],
  },
  tags: { type: 'list', hint: 'Tags', suggestions: ['x'] },
  timeout: { type: 'number', hint: 'Timeout', integer: true, min: 1, nullable: true },
  strict: { type: 'flag', hint: 'Strict' },
  locked: { type: 'text', hint: 'Locked', off: true },
} satisfies AssistantSpec;

describe('assistantSchema — задание модели', () => {
  const schema = assistantSchema(SPEC);

  it('перечислимые несут допустимые значения с подписями', () => {
    expect(schema.color).toContain('"red" (Red colour)');
    expect(schema.members).toContain('"rule:a" (Rule A)');
    expect(schema.members).toContain('JSON array');
  });

  it('вид значения назван у каждого поля', () => {
    expect(schema.name).toContain('a string');
    expect(schema.tags).toContain('JSON array of strings');
    expect(schema.tags).toContain('"x"');
    expect(schema.timeout).toContain('an integer from 1');
    expect(schema.timeout).toContain('null');
    expect(schema.strict).toContain('true or false');
  });

  it('закрытое поле модели не предлагается', () => {
    expect(Object.keys(schema)).not.toContain('locked');
  });

  it('длинный каталог обрезается и говорит об этом', () => {
    const options = Array.from({ length: MAX_LISTED_OPTIONS + 5 }, (_, i) => ({ value: `v${i}` }));
    const text = assistantSchema({ big: { type: 'choices', hint: 'Big', options } }).big;
    expect(text).toContain('"v0"');
    expect(text).not.toContain(`"v${MAX_LISTED_OPTIONS}"`);
    expect(text).toContain('and 5 more exist');
  });

  it('пустой каталог так и назван', () => {
    expect(assistantSchema({ e: { type: 'choices', hint: 'E', options: [] } }).e).toContain(
      'none exist yet',
    );
  });
});

describe('readAssistantFields — проверка ответа', () => {
  it('годные значения применяются всех видов', () => {
    const reading = readAssistantFields(SPEC, {
      name: 'N',
      color: 'blue',
      members: ['skill:b', 'rule:a'],
      tags: [' a ', 'a', ''],
      timeout: 30,
      strict: true,
    });
    expect(reading.values).toEqual({
      name: 'N',
      color: 'blue',
      members: ['skill:b', 'rule:a'],
      tags: ['a'],
      timeout: 30,
      strict: true,
    });
    expect(reading.applied).toEqual(['name', 'color', 'members', 'tags', 'timeout', 'strict']);
    expect(reading.missed).toEqual([]);
  });

  it('несуществующий id отброшен и назван, известные применены', () => {
    const reading = readAssistantFields(SPEC, { members: ['rule:a', 'rule:zzz'] });
    expect(reading.values.members).toEqual(['rule:a']);
    expect(reading.missed).toEqual([
      { field: 'members', reason: 'unknown-value', values: ['rule:zzz'] },
    ]);
  });

  it('список из одних выдумок не стирает поле', () => {
    const reading = readAssistantFields(SPEC, { members: ['rule:zzz'] });
    expect(reading.applied).toEqual([]);
    expect(reading.values).toEqual({});
    expect(reading.missed[0]).toMatchObject({ field: 'members', reason: 'unknown-value' });
  });

  it('пустой список — осознанная очистка, применяется', () => {
    expect(readAssistantFields(SPEC, { members: [] }).values.members).toEqual([]);
  });

  it('вариант находится без регистра и по подписи, если он один', () => {
    expect(readAssistantFields(SPEC, { color: 'RED' }).values.color).toBe('red');
    expect(readAssistantFields(SPEC, { members: ['Skill B'] }).values.members).toEqual(['skill:b']);
  });

  it('неизвестный вариант выбора не применён и назван', () => {
    const reading = readAssistantFields(SPEC, { color: 'green' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'color', reason: 'unknown-value', values: ['green'] },
    ]);
  });

  it('значение не того вида не применяется ни в одном поле', () => {
    const reading = readAssistantFields(SPEC, {
      name: ['x'],
      color: 1,
      members: 'rule:a',
      tags: [1],
      timeout: 1.5,
      strict: 'yes',
    });
    expect(reading.values).toEqual({});
    expect(reading.missed.map((miss) => miss.reason)).toEqual(Array(6).fill('wrong-type'));
  });

  it('число: строка-число принимается, вне границ и null без nullable — нет', () => {
    expect(readAssistantFields(SPEC, { timeout: '45' }).values.timeout).toBe(45);
    expect(readAssistantFields(SPEC, { timeout: null }).values.timeout).toBeNull();
    expect(readAssistantFields(SPEC, { timeout: 0 }).missed[0]?.reason).toBe('wrong-type');
    const capped = { n: { type: 'number', hint: 'N', max: 5 } } satisfies AssistantSpec;
    expect(readAssistantFields(capped, { n: 6 }).missed[0]?.reason).toBe('wrong-type');
    expect(readAssistantFields(capped, { n: null }).missed[0]?.reason).toBe('wrong-type');
  });

  it('текст принимает число и логическое значение строкой', () => {
    expect(readAssistantFields(SPEC, { name: 42 }).values.name).toBe('42');
    expect(readAssistantFields(SPEC, { name: false }).values.name).toBe('false');
  });

  it('чужое поле и закрытое поле названы, не применены', () => {
    const reading = readAssistantFields(SPEC, { bogus: 1, locked: 'x', toString: 'y' });
    expect(reading.values).toEqual({});
    expect(reading.missed).toEqual([
      { field: 'bogus', reason: 'unknown-field' },
      { field: 'locked', reason: 'locked' },
      { field: 'toString', reason: 'unknown-field' },
    ]);
  });
});

describe('groupMisses — строки под ответом', () => {
  it('раскладывает по причинам', () => {
    expect(
      groupMisses([
        { field: 'members', reason: 'unknown-value', values: ['a', 'b'] },
        { field: 'when', reason: 'wrong-type' },
        { field: 'x', reason: 'unknown-field' },
        { field: 'y', reason: 'locked' },
      ]),
    ).toEqual({
      values: ['members: a, b'],
      types: ['when'],
      fields: ['x', 'y'],
      secrets: [],
    });
  });
});
