import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Пробелы автономии 24.10 на вырезках НАСТОЯЩИХ транскриптов, через сторож целиком
 * (поток → свёртка → списки группы → правила → сигналы записи группы):
 *
 * - R34 — разговор A кончился в 23:57:33 с окном 157k, через 12 с панель начала разговор B
 *   по передаче, и его первый ход заново записал в кэш 66k (`R34-fresh-over-warm/`);
 * - R35 — разговор A перезаписал два файла и закоммитил их (второй — `git add` каталога),
 *   через час разговор B перезаписал оба почти теми же строками (`R35-redo-committed/fire-*`);
 *   соседний случай — B правит те же файлы рядом с закоммиченным (`near-miss-*`).
 *
 * Строки Write обезличены построчно (одна строка — один отпечаток), так что доля
 * совпавших строк, которую меряет правило, та же, что была.
 */

const MIN = 60_000;
const DIR = new URL('./__fixtures__/leak/', import.meta.url);

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
}
interface Row {
  type: 'assistant' | 'user';
  timestamp: string;
  message: { model?: string; usage?: Usage; content: unknown };
}
interface Item {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const rows = (name: string): Row[] =>
  readFileSync(new URL(name, DIR), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

/** Строка транскрипта → события живого потока, как их шлёт прогон (`ChatRunner.translate`). */
function chatEvents(row: Row): ChatEvent[] {
  const items = Array.isArray(row.message.content) ? (row.message.content as Item[]) : [];
  const out: ChatEvent[] = [];
  for (const item of items) {
    if (item.type === 'tool_use' && item.id && item.name) {
      out.push({ kind: 'tool', id: item.id, name: item.name, input: item.input });
    }
    if (item.type === 'tool_result' && item.tool_use_id) {
      out.push({
        kind: 'toolResult',
        toolUseId: item.tool_use_id,
        chars: JSON.stringify(item.content ?? '').length,
        ...(item.is_error ? { isError: true as const } : {}),
      });
    }
  }
  const usage = row.type === 'assistant' ? row.message.usage : undefined;
  if (usage) {
    out.push({
      kind: 'usage',
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheCreation1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ...(row.message.model ? { model: row.message.model } : {}),
    });
  }
  return out;
}

function setup(settings: Partial<GroupWatch> = {}) {
  let now = 0;
  const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  let stageSince: number | undefined;
  let id = 0;
  const watcher = new GroupWatcher({
    settings: () => ({ ...GROUP_WATCH_DEFAULTS, ...settings }),
    resolve: (chatId) => ({ chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }),
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: () => {},
    node: () => ({
      running: true,
      paused: false,
      stage: 'work',
      ...(stageSince !== undefined ? { stageSince } : {}),
    }),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group] } }),
  });
  const at = (t: number): void => {
    now = t;
  };
  return {
    watcher,
    at,
    stageFrom: (t: number) => {
      stageSince = t;
    },
    /**
     * Ход разговора: старт под ключом `key` (без id сессии — новый разговор, с id —
     * продолжение), строки вырезки по их времени (+ сдвиг), конец хода.
     */
    turn: (
      key: string,
      sessionId: string,
      list: readonly Row[],
      opts: { resume?: boolean; startAt?: number; shift?: number } = {},
    ) => {
      const shift = opts.shift ?? 0;
      at(opts.startAt ?? Date.parse(list[0]?.timestamp ?? '') + shift);
      watcher.onFeed(key, {
        kind: 'start',
        cwd: '/w/app',
        ...(opts.resume ? { sessionId } : {}),
      });
      for (const row of list) {
        at(Date.parse(row.timestamp) + shift);
        for (const event of chatEvents(row)) {
          watcher.onFeed(key, { kind: 'event', event, sessionId });
        }
      }
      watcher.onFeed(key, { kind: 'finish', sessionId });
    },
    signal: (rule: string): GroupSignal | undefined =>
      (group.watch?.signals ?? []).find((signal) => signal.rule === rule && !signal.clearedAt),
  };
}

const prev = rows('R34-fresh-over-warm/prev-last-call.jsonl');
const first = rows('R34-fresh-over-warm/fresh-first-turn.jsonl');

describe('R34: новый разговор группы поверх тёплого (вырезка 22.10)', () => {
  it('передача через 12 с после последнего вызова: первый ход записал 66k из окна 157k — справка «по делу»', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev);
    w.turn('new-g1-b', 'sess-b', first);
    expect(w.signal('R34')).toMatchObject({
      severity: 'info',
      numbers: { writeK: 66, prevK: 157 },
      params: { cause: 'handoff' },
    });
  });

  it('тот же разговор продолжен новым по вводной (ключ — id прежней сессии) — лишний старт, внимание', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev);
    w.turn('sess-a', 'sess-b', first);
    expect(w.signal('R34')).toMatchObject({ severity: 'warn', params: { cause: 'cold-brief' } });
  });

  it('новая стадия — повод «смена стадии», доставка — «доставка»', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev);
    w.turn('new-g1-b-deliver1', 'sess-b', first);
    expect(w.signal('R34')?.params).toEqual({ cause: 'deliver' });
  });

  it('прошлый разговор остыл (пауза дольше срока остывания) — пересборка честная, сигнала нет', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev, { shift: -60 * MIN });
    w.turn('new-g1-b', 'sess-b', first);
    expect(w.signal('R34')).toBeUndefined();
  });

  it('пинг тёплого кэша держит прошлый разговор тёплым: старт через 70 мин после вызова — R34', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev, { shift: -70 * MIN });
    const pingAt = Date.parse(first[0]?.timestamp ?? '') - 20 * MIN;
    w.at(pingAt);
    w.watcher.warmed('sess-a', pingAt, pingAt - 50 * MIN);
    w.turn('new-g1-b', 'sess-b', first);
    expect(w.signal('R34')).toBeDefined();
  });

  it('порог: запись первого хода ровно на пороге — сигнал, на токен выше — нет', () => {
    const at = setup({ freshRewriteTokens: 65_706 });
    at.turn('new-g1-a', 'sess-a', prev);
    at.turn('new-g1-b', 'sess-b', first);
    expect(at.signal('R34')).toBeDefined();
    const above = setup({ freshRewriteTokens: 65_707 });
    above.turn('new-g1-a', 'sess-a', prev);
    above.turn('new-g1-b', 'sess-b', first);
    expect(above.signal('R34')).toBeUndefined();
  });

  it('продолжение того же разговора (`--resume`) — не новый разговор', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', prev);
    w.turn('sess-a', 'sess-a', first, { resume: true });
    expect(w.signal('R34')).toBeUndefined();
  });

  it('смена модели на тёплом продолжении: окно записано заново — R34 «смена модели», внимание', () => {
    const w = setup();
    const last = Date.parse(prev[0]?.timestamp ?? '');
    const call = (t: number, model: string, write: number): Row => ({
      type: 'assistant',
      timestamp: new Date(t).toISOString(),
      message: {
        model,
        usage: { input_tokens: 2, output_tokens: 300, cache_creation_input_tokens: write },
        content: [],
      },
    });
    // Первый вызов разговора — база окна (системная вводная), последний — вырезка A.
    w.turn('new-g1-a', 'sess-a', [call(last - 30 * MIN, 'claude-opus-5-5', 20_000), ...prev]);
    w.turn('sess-a', 'sess-a', [call(last + 5 * MIN, 'claude-sonnet-5-5', 156_000)], {
      resume: true,
    });
    expect(w.signal('R34')).toMatchObject({
      severity: 'warn',
      numbers: { writeK: 156 },
      params: { cause: 'model-switch' },
    });
  });
});

describe('R35: новый разговор переделывает закоммиченное на этой стадии (вырезка 21.10)', () => {
  const committed = rows('R35-redo-committed/fire-committed.jsonl');
  const redo = rows('R35-redo-committed/fire-redo.jsonl');

  it('два файла из двух коммитов A перезаписаны B теми же строками — внимание, 2 файла', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', committed);
    w.turn('new-g1-b', 'sess-b', redo);
    expect(w.signal('R35')).toMatchObject({
      severity: 'warn',
      numbers: { files: 2 },
      // Путь — как его назвал вызов, не сведённый к нижнему регистру для сравнения.
      params: { path: 'flag/useFlag.ts' },
    });
  });

  it('порог `redoFiles`: 2 — сигнал (выше), 3 — тишина', () => {
    const w = setup({ redoFiles: 3 });
    w.turn('new-g1-a', 'sess-a', committed);
    w.turn('new-g1-b', 'sess-b', redo);
    expect(w.signal('R35')).toBeUndefined();
  });

  it('свой коммит разговор не повторяет: те же правки в том же разговоре — не R35', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', committed);
    w.turn('sess-a', 'sess-a', redo, { resume: true });
    expect(w.signal('R35')).toBeUndefined();
  });

  it('коммиты прошлой стадии (раньше начала звена) — не переделка этой', () => {
    const w = setup();
    w.turn('new-g1-a', 'sess-a', committed);
    w.stageFrom(Date.parse(redo[0]?.timestamp ?? '') - MIN);
    w.turn('new-g1-b', 'sess-b', redo);
    expect(w.signal('R35')).toBeUndefined();
  });

  it('B правит те же файлы рядом с закоммиченным (вырезка 20.10) — не повтор', () => {
    const w = setup({ redoFiles: 1 });
    w.turn('new-g1-a', 'sess-a', rows('R35-redo-committed/near-miss-committed.jsonl'));
    w.turn('new-g1-b', 'sess-b', rows('R35-redo-committed/near-miss-redo.jsonl'));
    expect(w.signal('R35')).toBeUndefined();
  });
});
