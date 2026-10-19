import { describe, expect, it } from 'vitest';
import { sessionTime, unionMs } from './time.ts';

/**
 * Пауза посреди работы группы (живой прогон 16→19.10.2026): процесс убит на
 * вызове, возобновление через двое суток. Карточка показывала 52 ч «работы»
 * у группы, работавшей ~4 ч, — эти случаи и проверяются.
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-10-16T15:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const prompt = (ms: number, text = 'сделай') => ({
  type: 'user',
  timestamp: at(ms),
  message: { role: 'user', content: text },
});
const call = (ms: number, id: string, name = 'Bash') => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
});
const done = (ms: number, id: string, content = 'ok') => ({
  type: 'user',
  timestamp: at(ms),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const text = (ms: number, stop?: string) => ({
  type: 'assistant',
  timestamp: at(ms),
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'ответ' }],
    ...(stop ? { stop_reason: stop } : {}),
  },
});

const active = (rows: object[]) => unionMs(sessionTime(rows as never)?.busy ?? []);

describe('sessionTime: пауза и обрыв не считаются работой', () => {
  it('вызов, оборванный паузой и закрытый при возобновлении через двое суток, — ноль, а не двое суток', () => {
    const rows = [
      prompt(0),
      call(1 * MIN, 't1'),
      done(
        2 * DAY,
        't1',
        "[Tool call interrupted: the session ended before this call's result was recorded]",
      ),
      prompt(2 * DAY + 1000, 'Группу возобновили'),
      text(2 * DAY + 2 * MIN, 'end_turn'),
    ];
    // Модель 0→1 мин, вызов оборван (конец неизвестен — не позже записи перед обрывом),
    // после возобновления модель 2 мин.
    expect(active(rows)).toBe(1 * MIN + 2 * MIN - 1000);
  });

  it('ответ, оборванный паузой, не тянется до следующей реплики через сутки', () => {
    const rows = [
      prompt(0),
      text(1 * MIN),
      prompt(DAY, 'продолжай'),
      text(DAY + 1 * MIN, 'end_turn'),
    ];
    expect(active(rows)).toBe(2 * MIN);
  });

  it('вызов инструмента дольше 15 мин режется до 15 мин; субагент — нет', () => {
    const bash = [
      prompt(0),
      call(0, 'b1'),
      done(3 * 60 * MIN, 'b1'),
      text(3 * 60 * MIN, 'end_turn'),
    ];
    expect(active(bash)).toBe(15 * MIN);
    const agent = [
      prompt(0),
      call(0, 'a1', 'Agent'),
      done(60 * MIN, 'a1'),
      text(60 * MIN, 'end_turn'),
    ];
    expect(active(agent)).toBe(60 * MIN);
  });

  it('обычная работа считается целиком: вызов 9 мин, простой между ходами — нет', () => {
    const rows = [
      prompt(0),
      call(1 * MIN, 'g1'),
      done(10 * MIN, 'g1'),
      text(11 * MIN, 'end_turn'),
      prompt(60 * MIN),
      text(62 * MIN, 'end_turn'),
    ];
    expect(active(rows)).toBe(11 * MIN + 2 * MIN);
  });
});
