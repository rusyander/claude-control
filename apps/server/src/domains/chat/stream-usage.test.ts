import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TurnTracker } from './stream-usage.ts';
import type { ChatEvent, RawEvent } from './ChatRunner.ts';

/**
 * Расход по ходам модели из настоящего потока `stream-json`.
 *
 * Запись — реальный прогон claude 2.1.177 (вызов Bash + текст, два хода):
 * четыре события `assistant` на два хода, `usage` в них — заглушка. Правильный
 * разбор даёт РОВНО два события расхода с выходом из `message_delta`, вызов
 * первого хода привязан к нему, а сумма сходится с итогом прогона без остатка.
 */
const FIXTURE = fileURLToPath(new URL('./__fixtures__/stream-json-2.1.177.jsonl', import.meta.url));

type Usage = Extract<ChatEvent, { kind: 'usage' }>;

function replay(lines: RawEvent[]): ChatEvent[] {
  const tracker = new TurnTracker();
  return lines.flatMap((line) => tracker.track(line));
}

function usages(events: ChatEvent[]): Usage[] {
  return events.filter((event): event is Usage => event.kind === 'usage');
}

const raw = (value: unknown): RawEvent => value as RawEvent;

describe('TurnTracker — настоящий поток claude 2.1.177', () => {
  const lines = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RawEvent);

  it('один ход — одно событие расхода, а не по одному на блок', () => {
    const spent = usages(replay(lines));
    expect(lines.filter((line) => line.type === 'assistant')).toHaveLength(4);
    expect(spent).toHaveLength(2);
  });

  it('выход берётся из message_delta, а не из заглушки message_start', () => {
    const [first, second] = usages(replay(lines));
    expect(first).toMatchObject({ input: 10, output: 160, cacheCreation: 29291, cacheRead: 0 });
    expect(second).toMatchObject({ input: 8, output: 59, cacheCreation: 184, cacheRead: 29291 });
    expect(first?.cacheCreation1h).toBe(29291);
  });

  it('модель хода и его вызовы приходят вместе с расходом', () => {
    const [first, second] = usages(replay(lines));
    expect(first?.model).toBe('claude-haiku-4-5-20251001');
    expect(first?.toolIds).toEqual(['toolu_01DUDaZbPwybPxnaj7s1J6wS']);
    expect(second?.toolIds).toEqual([]);
  });

  it('сумма ходов сходится с итогом прогона — остатка нет', () => {
    const spent = usages(replay(lines));
    expect(spent.some((event) => event.remainder)).toBe(false);
    const output = spent.reduce((sum, event) => sum + event.output, 0);
    expect(output).toBe(219);
  });
});

describe('TurnTracker — края', () => {
  const start = (id: string, model = 'opus'): RawEvent =>
    raw({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id, model, usage: { input_tokens: 5, output_tokens: 1 } },
      },
    });
  const delta = (output: number): RawEvent =>
    raw({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 5, output_tokens: output } },
    });
  const assistant = (id: string, content: unknown[], usage?: unknown): RawEvent =>
    raw({ type: 'assistant', message: { id, model: 'opus', content, usage } });
  const blockStart = (type: string): RawEvent =>
    raw({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type } } });
  const textDelta = (text: string): RawEvent =>
    raw({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });

  it('вызовы нескольких блоков одного хода собираются в один список', () => {
    const events = replay([
      start('m1'),
      assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read' }]),
      assistant('m1', [{ type: 'tool_use', id: 't2', name: 'Bash' }]),
      delta(40),
    ]);
    expect(usages(events)).toEqual([expect.objectContaining({ output: 40, toolIds: ['t1', 't2'] })]);
  });

  it('без потоковых событий расход берётся из assistant — один раз на ход', () => {
    const usage = { input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 100 };
    const events = replay([
      assistant('m1', [{ type: 'thinking', thinking: 'хм' }], usage),
      assistant('m1', [{ type: 'text', text: 'ответ' }], usage),
      assistant('m2', [{ type: 'text', text: 'ещё' }], { input_tokens: 4, output_tokens: 7 }),
    ]);
    expect(usages(events).map((event) => event.output)).toEqual([30, 7]);
  });

  it('итог прогона больше суммы ходов — разница уходит остатком без вызовов', () => {
    const events = replay([
      start('m1'),
      delta(40),
      raw({
        type: 'result',
        usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 700 },
        modelUsage: { opus: {} },
      }),
    ]);
    const [, rest] = usages(events);
    expect(rest).toMatchObject({ remainder: true, output: 60, cacheRead: 700, input: 0 });
    expect(rest?.model).toBe('opus');
    expect(rest?.toolIds).toBeUndefined();
  });

  it('итог меньше насчитанного — остатка нет', () => {
    const events = replay([
      start('m1'),
      delta(40),
      raw({ type: 'result', usage: { input_tokens: 1, output_tokens: 10 } }),
    ]);
    expect(usages(events)).toHaveLength(1);
  });

  it('второй текстовый блок отделяется от первого абзацем, первый — нет', () => {
    const events = replay([
      blockStart('text'),
      textDelta('первый'),
      blockStart('tool_use'),
      blockStart('text'),
      textDelta('второй'),
    ]);
    expect(events).toEqual([{ kind: 'text', text: '\n\n' }]);
  });

  it('пустой текстовый блок абзаца не даёт: разделять нечего', () => {
    const events = replay([
      blockStart('text'),
      textDelta('первый'),
      blockStart('text'),
      blockStart('text'),
      textDelta('второй'),
    ]);
    expect(events).toEqual([{ kind: 'text', text: '\n\n' }]);
  });

  it('ход субагента в шаги не идёт — он доедет остатком сверки', () => {
    const usage = { input_tokens: 3, output_tokens: 500 };
    const events = replay([
      raw({
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: { id: 'sub', model: 'haiku', content: [{ type: 'text', text: 'ответ' }], usage },
      }),
      raw({ type: 'result', usage: { input_tokens: 3, output_tokens: 500 } }),
    ]);
    expect(usages(events)).toEqual([expect.objectContaining({ remainder: true, output: 500 })]);
  });

  it('остаток из одной часовой доли кэша не теряется', () => {
    const events = replay([
      raw({
        type: 'result',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 700 },
        },
      }),
    ]);
    expect(usages(events)).toEqual([
      expect.objectContaining({ remainder: true, cacheCreation1h: 700 }),
    ]);
  });
});
