import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WatchEvent } from '../watch/watch.types.ts';
import { foreignStreamReader, geminiStreamEvents, readsForeignStream } from './foreign-stream.ts';

/**
 * Поток `gemini -o stream-json` — запись НАСТОЯЩЕГО gemini 0.62.0 на подменной модели во
 * временном доме: шесть ходов `-p` подряд (MULTI, EXIT, HOOK, POLICY, DENY, WRITE_OFF),
 * отказ хука набора, отказ правила политики, инструмент вне набора, ненулевой выход
 * оболочки с выводом и без. Пути обезличены (`C:\qa`).
 */
const ROWS = readFileSync(
  join(import.meta.dirname, '__fixtures__', 'gemini-0.62-stream-watch.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean);

/** Строки одного хода: от его `init` до `result`, по слову из промпта. */
function turn(word: string): string[] {
  const start = ROWS.findIndex((line) => line.includes(`"content":"QA_${word} go"`)) - 1;
  const end = ROWS.findIndex((line, i) => i > start && line.includes('"type":"result"'));
  if (start < 0 || end < 0) throw new Error(`fixture lacks turn ${word}`);
  return ROWS.slice(start, end + 1);
}

const events = (rows: readonly string[]): WatchEvent[] => {
  const read = geminiStreamEvents();
  return rows.flatMap((line) => read(JSON.parse(line)));
};
const of = <K extends WatchEvent['kind']>(list: readonly WatchEvent[], kind: K) =>
  list.filter((event): event is Extract<WatchEvent, { kind: K }> => event.kind === kind);

describe('foreign-stream: поток Gemini CLI → события сторожа', () => {
  it('вызовы — именами Claude, ответ — «жива», итог хода — вызов-итог по модели', () => {
    const list = events(turn('MULTI'));
    expect(of(list, 'tool')).toMatchObject([
      { name: 'Bash', input: { command: 'node -e "process.exit(3)"' } },
      { name: 'Read', input: { file_path: 'C:\\qa\\proj\\missing.txt' } },
    ]);
    expect(of(list, 'activity')).toHaveLength(1);
    // input_tokens 450 из них cached 120: новых 330, чтение кэша 120 — сумма всех запросов хода.
    expect(of(list, 'call')).toEqual([
      {
        kind: 'call',
        t: Date.parse('2026-10-27T09:58:17.340Z'),
        model: 'gemini-2.5-flash',
        input: 330,
        cacheRead: 120,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 9,
        turnTotal: true,
      },
    ]);
  });

  it('оболочка: код виден только без вывода; неверные параметры — ошибка рода other', () => {
    const [shell, read] = of(events(turn('MULTI')), 'toolResult');
    expect(shell).toMatchObject({ isError: true, errorKind: 'exit' });
    expect(read).toMatchObject({ isError: true, errorKind: 'other' });
    expect(read?.denied).toBeUndefined();
    // Ненулевой выход с выводом CLI шлёт как успех: потоку его не отличить.
    const [loud] = of(events(turn('EXIT')), 'toolResult');
    expect(loud).toBeDefined();
    expect(loud?.isError).toBeUndefined();
    expect(loud?.denied).toBeUndefined();
  });

  it('отказ хука набора назван стражем из причины, отказ политики — policy', () => {
    expect(of(events(turn('HOOK')), 'toolResult')).toMatchObject([{ denied: 'probe-guard' }]);
    expect(of(events(turn('POLICY')), 'toolResult')).toMatchObject([{ denied: 'policy' }]);
  });

  it('инструмента нет в наборе хода — no-tool (R29), не отказ', () => {
    for (const word of ['DENY', 'WRITE_OFF']) {
      const [result] = of(events(turn(word)), 'toolResult');
      expect(result).toMatchObject({ isError: true, errorKind: 'no-tool' });
      expect(result?.denied).toBeUndefined();
    }
    expect(of(events(turn('WRITE_OFF')), 'tool')).toMatchObject([
      { name: 'Edit', input: { file_path: 'w.txt' } },
    ]);
  });

  it('id вызова и его ответа совпадают — ответ закрывает свой вызов', () => {
    const list = events(ROWS);
    const tools = of(list, 'tool').map((event) => event.id);
    expect(tools).toHaveLength(7);
    expect(of(list, 'toolResult').map((event) => event.id)).toEqual(tools);
  });

  it('строка пользователя, init без времени и мусор — без событий', () => {
    const read = geminiStreamEvents();
    expect(read({ type: 'message', role: 'user', content: 'x', timestamp: 'now' })).toEqual([]);
    expect(read(null)).toEqual([]);
    expect(read(['row'])).toEqual([]);
    expect(
      read({ type: 'result', timestamp: '2026-10-27T10:00:00Z', stats: { input_tokens: 0 } }),
    ).toEqual([]);
  });

  it('итог без разбивки по моделям — модель из init', () => {
    const read = geminiStreamEvents();
    read({ type: 'init', timestamp: '2026-10-27T10:00:00Z', model: 'gemini-x' });
    expect(
      read({
        type: 'result',
        timestamp: '2026-10-27T10:00:01Z',
        stats: { input_tokens: 50, cached: 10, output_tokens: 5 },
      }),
    ).toMatchObject([{ kind: 'call', model: 'gemini-x', input: 40, cacheRead: 10, output: 5 }]);
  });

  it('поток строк читает только Gemini CLI', () => {
    expect(readsForeignStream('gemini')).toBe(true);
    for (const provider of ['claude', 'codex', 'qwen', 'continue', 'aider']) {
      expect(readsForeignStream(provider)).toBe(false);
      expect(foreignStreamReader(provider)).toBeUndefined();
    }
    expect(foreignStreamReader('gemini')).toBeTypeOf('function');
  });
});
