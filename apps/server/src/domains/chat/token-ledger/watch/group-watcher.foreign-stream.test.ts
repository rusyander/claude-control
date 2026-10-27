import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Сторож у группы Gemini CLI: файла переписки у хода `-p` нет — события он берёт из
 * строк потока хода (`{kind:'foreign'}`, как их шлёт runtime). Строки — запись
 * НАСТОЯЩЕГО gemini 0.62.0 (`foreign/__fixtures__/gemini-0.62-stream-watch.jsonl`);
 * вызов и ответ переносятся во времени и получают свой id, форма остаётся той же.
 */

const ROWS = readFileSync(
  join(import.meta.dirname, '..', 'foreign', '__fixtures__', 'gemini-0.62-stream-watch.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const MIN = 60_000;
const T0 = Date.parse('2026-10-27T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const KEY = foreignChatKey('gemini', 'child');
const DELIVER = 'deliver-1';

/** Вызов и его ответ из хода `word` — с новым id и временем. */
function pair(word: string, ms: number, id: string): Record<string, unknown>[] {
  const start = ROWS.findIndex((row) => row.content === `QA_${word} go`);
  const call = ROWS.slice(start).find((row) => row.type === 'tool_use');
  const result = ROWS.slice(start).find((row) => row.type === 'tool_result');
  if (!call || !result) throw new Error(`fixture lacks the ${word} call`);
  return [
    { ...call, tool_id: id, timestamp: at(ms) },
    { ...result, tool_id: id, timestamp: at(ms + 1000) },
  ];
}

/** Итог хода той же формы, что печатает CLI: `stats` с разбивкой по модели. */
const result = (ms: number, input: number, cached: number, output: number) => {
  const usage = { input_tokens: input, cached, output_tokens: output };
  return {
    type: 'result',
    timestamp: at(ms),
    status: 'success',
    stats: { ...usage, models: { 'gemini-2.5-flash': usage } },
  };
};

function watch() {
  let now = T0;
  const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const watcher = new GroupWatcher({
    settings: () => GROUP_WATCH_DEFAULTS,
    // Звено Gemini CLI и доставка той же группы на Claude (своя доставка группы).
    resolve: (chatId) =>
      chatId === KEY || chatId === DELIVER
        ? { chatId, parentChatId: 'gemini:parent', groupIndex: 1, stage: 'work', cwd: 'C:\\qa' }
        : undefined,
    group: (parent, index) => (parent === 'gemini:parent' && index === 1 ? group : undefined),
    save: () => {},
    node: () => ({ running: true, paused: false }),
    transcript: () => undefined,
    // Субагентов у хода Gemini CLI нет; у разговора Claude их папки во временном доме нет.
    subagentDir: (sessionId) => {
      if (sessionId.startsWith('gemini:')) {
        throw new Error('subagentDir must not be asked for a foreign session');
      }
      return undefined;
    },
    now: () => now,
    makeId: () => 'id',
    plans: () => ({ 'gemini:parent': { groups: [group] } }),
    // Сторож глотает свои ошибки (прогону они не мешают) — тесту проглоченная ошибка не зелёная.
    log: (message, error) => {
      throw new Error(`${message}: ${String(error)}`);
    },
  });
  // Как runtime: старт хода без потока Claude, место сессии — ключ разговора.
  watcher.onFeed(KEY, {
    kind: 'start',
    sessionId: KEY,
    cwd: 'C:\\qa',
    detached: true,
    provider: 'gemini',
  });
  const signals = () => (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt);
  return {
    watcher,
    signals,
    at: (t: number) => {
      now = t;
    },
    /** Строки потока по одной, время сторожа — время строки; тик через минуту после последней. */
    feed(rows: readonly Record<string, unknown>[], key = KEY) {
      for (const row of rows) {
        now = Date.parse(String(row.timestamp));
        watcher.onFeed(key, { kind: 'foreign', sessionId: key, row });
      }
      now += MIN;
      watcher.tick();
      return signals();
    },
  };
}

describe('сторож групп над потоком Gemini CLI', () => {
  it('пять отказов хука набора за 15 минут — R18 со стражем из причины; четыре — нет', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => pair('HOOK', 10_000 * (i + 1), `deny_${i}`)).flat();
    expect(
      watch()
        .feed(rows(4))
        .map((signal) => signal.rule),
    ).not.toContain('R18');
    const r18 = watch()
      .feed(rows(5))
      .find((signal) => signal.rule === 'R18');
    expect(r18?.numbers).toMatchObject({ denials: 5 });
    expect(r18?.params).toMatchObject({ guard: 'probe-guard' });
  });

  it('инструмент вне набора дважды — R29 с именем инструмента', () => {
    const one = watch().feed(pair('DENY', 10_000, 't1'));
    expect(one.map((signal) => signal.rule)).not.toContain('R29');
    const signals = watch().feed([
      ...pair('DENY', 10_000, 't1'),
      ...pair('WRITE_OFF', 20_000, 't2'),
    ]);
    const r29 = signals.find((signal) => signal.rule === 'R29');
    expect(r29?.numbers).toMatchObject({ calls: 2 });
    expect(r29?.params).toMatchObject({ tool: 'Edit' });
  });

  it('итоги ходов идут в расход группы (R8), но окно по ним не судится (R19, R2 молчат)', () => {
    // Три хода по миллиону с лишним за три минуты: модель прайсу неизвестна — вес как у Opus.
    const signals = watch().feed([
      result(1 * MIN, 1_000_000, 0, 1000),
      result(2 * MIN, 1_200_000, 0, 1000),
      result(3 * MIN, 1_400_000, 0, 1000),
    ]);
    const rules = signals.map((signal) => signal.rule);
    expect(rules).toContain('R8');
    expect(rules).not.toContain('R19');
    expect(rules).not.toContain('R2');
    expect(rules).not.toContain('R34');
  });

  it('доставка группы на Claude сразу после хода Gemini — не «новый разговор поверх тёплого» (R34)', () => {
    const w = watch();
    w.feed([result(MIN, 1_200_000, 0, 1000)]);
    // Через 12 с — разговор Claude той же группы; его первый ход записал в кэш 66k.
    w.at(T0 + MIN + 12_000);
    w.watcher.onFeed(DELIVER, { kind: 'start', cwd: 'C:\\qa' });
    w.watcher.onFeed(DELIVER, {
      kind: 'event',
      sessionId: 'sess-d',
      event: {
        kind: 'usage',
        input: 10,
        output: 200,
        cacheRead: 0,
        cacheCreation: 66_000,
        cacheCreation1h: 0,
        model: 'claude-sonnet-4-5',
      },
    });
    w.watcher.onFeed(DELIVER, { kind: 'finish', sessionId: 'sess-d' });
    w.at(T0 + 3 * MIN);
    w.watcher.tick();
    // Итог хода Gemini — не окно разговора: тёплого кэша Claude, который можно было
    // прочесть, не было, и пересборкой эта запись не считается.
    expect(w.signals().map((signal) => signal.rule)).not.toContain('R34');
  });

  it('строки потока у разговора Claude и у незнакомого ключа сторож не разбирает', () => {
    const w = watch();
    w.watcher.onFeed(DELIVER, { kind: 'start', cwd: 'C:\\qa' });
    const denials = Array.from({ length: 5 }, (_, i) =>
      pair('HOOK', 10_000 * (i + 1), `deny_${i}`),
    ).flat();
    expect(w.feed(denials, DELIVER).map((signal) => signal.rule)).not.toContain('R18');
    expect(watch().feed(denials, foreignChatKey('gemini', 'stranger'))).toEqual([]);
  });
});
