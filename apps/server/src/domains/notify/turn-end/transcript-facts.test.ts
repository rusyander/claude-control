import { describe, expect, it } from 'vitest';
import type { Record } from '../../chat/ChatRecords/ChatRecords.ts';
import { turnFactsOf } from './transcript-facts.ts';

/**
 * Факты конца хода из транскрипта сессии вне панели: записи той же формы, что
 * пишет Claude Code (тексты и ключи — выдуманные).
 */

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const human = (minutes: number, text: string): Record =>
  ({ type: 'user', timestamp: at(minutes), message: { role: 'user', content: text } }) as Record;

const say = (
  minutes: number,
  id: string,
  blocks: unknown[],
  stop: string | null = 'end_turn',
  uuid = `u-${id}-${minutes}`,
): Record =>
  ({
    type: 'assistant',
    uuid,
    timestamp: at(minutes),
    message: { id, role: 'assistant', stop_reason: stop, content: blocks },
  }) as Record;

const text = (value: string) => ({ type: 'text', text: value });
const tool = (id: string, name = 'Bash', input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const result = (minutes: number, id: string, extra: object = {}): Record =>
  ({
    type: 'user',
    timestamp: at(minutes),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    ...extra,
  }) as Record;

const ASK = {
  questions: [
    {
      question: 'Какой порт оставить?',
      options: [
        { label: '3000', description: 'как было' },
        { label: '8080', description: 'как у стенда' },
      ],
    },
  ],
};

describe('turnFactsOf', () => {
  it('итог — текст после последнего инструмента; начало — реплика человека, конец — запись end_turn', () => {
    const facts = turnFactsOf(
      [
        human(0, 'старый ход'),
        say(1, 'm0', [text('ок')]),
        human(10, 'Почини сборку'),
        say(11, 'm1', [text('Смотрю логи.'), tool('t1')], 'tool_use'),
        result(12, 't1'),
        say(40, 'm2', [text('Задача закрыта: сборка зелёная.')], 'end_turn', 'closing'),
      ],
      T0 + 41 * 60_000,
    );
    expect(facts).toEqual({
      startedAt: T0 + 10 * 60_000,
      earliest: T0,
      closingId: 'closing',
      endedAt: T0 + 40 * 60_000,
      answer: 'Задача закрыта: сборка зелёная.',
    });
  });

  it('висящий AskUserQuestion — вопрос и подписи вариантов; отвеченный — уже не висит', () => {
    const asked = [
      human(0, 'Подними стенд'),
      say(5, 'm1', [text('Нужно выбрать порт.'), tool('q1', 'AskUserQuestion', ASK)], 'tool_use'),
      say(5, 'm1', [], 'end_turn', 'closing'),
    ];
    expect(turnFactsOf(asked, T0)).toMatchObject({
      asked: true,
      question: 'Какой порт оставить?',
      options: ['3000', '8080'],
    });
    const answered = turnFactsOf(
      [...asked.slice(0, 2), result(6, 'q1'), say(7, 'm2', [text('Оставил 3000.')])],
      T0,
    );
    expect(answered.asked).toBeUndefined();
    expect(answered.answer).toBe('Оставил 3000.');
  });

  it('работа пошла дальше: хук Stop отбил конец, очередь, новый ответ модели, реплика человека', () => {
    const base = [human(0, 'Сделай'), say(5, 'm1', [text('Задача закрыта.')], 'end_turn', 'c1')];
    const after = (...records: object[]) =>
      turnFactsOf([...base, ...(records as Record[])], T0).continued;
    expect(after()).toBeUndefined();
    // Та же реплика модели, разбитая на записи, — не продолжение.
    expect(after(say(5, 'm1', [text('ещё строка')], 'end_turn', 'c1b'))).toBeUndefined();
    expect(after({ type: 'system', subtype: 'stop_hook_summary', hookErrors: [] })).toBeUndefined();
    expect(after({ type: 'system', subtype: 'stop_hook_summary', hookErrors: ['гейт'] })).toBe(
      true,
    );
    expect(after({ type: 'queue-operation', operation: 'enqueue' })).toBe(true);
    expect(
      after(
        { type: 'queue-operation', operation: 'enqueue' },
        { type: 'queue-operation', operation: 'dequeue' },
      ),
    ).toBeUndefined();
    expect(after({ type: 'attachment', attachment: { type: 'queued_command' } })).toBe(true);
    expect(after(say(6, 'm2', [tool('t9')], 'tool_use'))).toBe(true);
  });

  it('конца хода нет — ход идёт: без записи конца и без итога', () => {
    expect(turnFactsOf([human(0, 'Сделай'), say(1, 'm1', [tool('t1')], 'tool_use')], T0)).toEqual({
      startedAt: T0,
      earliest: T0,
      continued: true,
    });
  });

  it('пробуждение назначено на будущее — wakeup; прошедшее — нет; записи субагента не в счёт', () => {
    const records = [
      human(0, 'Следи за прогоном'),
      say(1, 'm1', [tool('w1', 'ScheduleWakeup')], 'tool_use'),
      result(1, 'w1', { toolUseResult: { scheduledFor: T0 + 30 * 60_000 } }),
      { ...say(2, 'side', [text('Задача субагента закрыта.')]), isSidechain: true } as Record,
      say(2, 'm2', [text('Жду прогон.')], 'end_turn', 'closing'),
    ];
    expect(turnFactsOf(records, T0 + 5 * 60_000)).toMatchObject({
      wakeup: true,
      answer: 'Жду прогон.',
      closingId: 'closing',
    });
    expect(turnFactsOf(records, T0 + 31 * 60_000).wakeup).toBeUndefined();
  });
});
