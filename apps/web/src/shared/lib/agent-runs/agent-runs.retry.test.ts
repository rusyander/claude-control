import { describe, it, expect } from 'vitest';
import { pickRetryPrompt } from './agent-runs.retry';

/**
 * Авто-повтор после обрыва: задача заново или «продолжай» — по транскрипту.
 * Второй раз ту же реплику не отправляем: агент начинал бы всё заново, хотя
 * половина сделанного уже в истории.
 */
const START = Date.parse('2026-09-02T12:00:00.000Z');
const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();
const base = { lastPrompt: 'собери отчёт', continuation: 'продолжай с места обрыва' };

describe('pickRetryPrompt', () => {
  it('реплика уже в транскрипте — просим продолжить, не повторяя задачу', () => {
    const history = [
      { role: 'user', timestamp: at(-90_000) },
      { role: 'assistant', timestamp: at(-80_000) },
      { role: 'user', timestamp: at(300) },
      { role: 'assistant', timestamp: at(4000) },
    ];
    expect(pickRetryPrompt({ ...base, startedAt: START, history })).toBe(base.continuation);
  });

  it('в транскрипте только прошлые реплики — прогон до неё не дожил, задача заново', () => {
    const history = [
      { role: 'user', timestamp: at(-90_000) },
      { role: 'assistant', timestamp: at(-80_000) },
    ];
    expect(pickRetryPrompt({ ...base, startedAt: START, history })).toBe(base.lastPrompt);
  });

  it('старт неизвестен — до модели не дошло, задача заново', () => {
    const history = [{ role: 'user', timestamp: at(300) }];
    expect(pickRetryPrompt({ ...base, startedAt: undefined, history })).toBe(base.lastPrompt);
  });

  it('ответ модели после старта без своей реплики — не доказательство', () => {
    const history = [{ role: 'assistant', timestamp: at(4000) }];
    expect(pickRetryPrompt({ ...base, startedAt: START, history })).toBe(base.lastPrompt);
  });
});
