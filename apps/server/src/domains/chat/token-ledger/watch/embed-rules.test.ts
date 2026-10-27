import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupSignal,
  type GroupWatch,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupLedgers } from './group-ledgers.ts';
import { sweepGroups } from './group-watcher/group-sweep.ts';
import { noteEmbedResult } from './reduce-embed.ts';
import { createWatchState, reduce } from './reduce.ts';
import { escalateBurn } from './rules-embed.ts';
import { evaluate, groupGates, type GatePoint } from './rules.ts';
import { mergeSignals } from './signals.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { OpenTool, RuleHit, WatchEvent, WatchNode, WatchState } from './watch.types.ts';

/**
 * Правила, перенесённые из внешнего сторожа 27.10 (`watchdog-embed-rules`), на вырезках,
 * собранных по строкам журнала живого прогона (`.agent/live-watch`): R21 считает проходы,
 * а не команды; R4 не сбрасывает правка заметок; запуск инструмента панели через
 * переменную — не R7; R16 «шёл долго» и «фон долго»; R37 длинная вводная; R44 признание
 * пропуска; R45 D-n, который панель не разрешила сама; BURN — два круга в одном ходе.
 * Каждая вырезка — пара: срабатывание и близкий промах.
 */

const MIN = 60_000;
const CWD = '/work/app';

function events(name: string): WatchEvent[] {
  const read = createTranscriptReader();
  return readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => read(JSON.parse(line) as unknown));
}

interface Run {
  settings?: Partial<GroupWatch>;
  node?: Partial<WatchNode>;
  now?: number;
  panelRoot?: string;
}

function fold(list: readonly WatchEvent[], run: Run = {}): WatchState {
  const ctx = {
    settings: { ...GROUP_WATCH_DEFAULTS, ...run.settings },
    cwd: CWD,
    ...(run.panelRoot ? { panelRoot: run.panelRoot } : {}),
  };
  const state = createWatchState(list[0]?.t ?? 0);
  for (const event of list) reduce(state, event, ctx);
  return state;
}

function judge(list: readonly WatchEvent[], run: Run = {}): RuleHit[] {
  const ctx = {
    settings: { ...GROUP_WATCH_DEFAULTS, ...run.settings },
    cwd: CWD,
    ...(run.panelRoot ? { panelRoot: run.panelRoot } : {}),
  };
  const node: WatchNode = {
    chatId: 'c1',
    groupIndex: 1,
    running: true,
    paused: false,
    ...run.node,
  };
  return evaluate(fold(list, run), node, ctx, run.now ?? (list.at(-1)?.t ?? 0) + MIN);
}

const hit = (list: readonly WatchEvent[], rule: string, run: Run = {}) =>
  judge(list, run).find((one) => one.rule === rule);
const end = (list: readonly WatchEvent[]): number => list.at(-1)?.t ?? 0;
const points = (state: WatchState): GatePoint[] =>
  state.heavyChecks.map((check) => ({ ...check, chatId: 'c1', pass: check.editAt ?? 0 }));

describe('R21 считает проходы гейта, а не команды (g5 26.10)', () => {
  it('две команды по одному дереву — один проход; правки и цепочка снова — второй, «внимание»', () => {
    const near = fold(events('R21-gate-passes/near-miss.jsonl'));
    expect(near.heavyChecks).toHaveLength(2);
    expect(groupGates(points(near), GROUP_WATCH_DEFAULTS, near.lastEventAt + MIN)).toBeUndefined();

    const fire = fold(events('R21-gate-passes/fire.jsonl'));
    expect(fire.heavyChecks).toHaveLength(3);
    const gates = groupGates(points(fire), GROUP_WATCH_DEFAULTS, fire.lastEventAt + MIN);
    expect(gates).toMatchObject({ rule: 'R21', numbers: { gates: 2, totalMin: 27 } });
    // Порог 3 прохода — два ещё не круг.
    expect(
      groupGates(points(fire), { ...GROUP_WATCH_DEFAULTS, gateRepeats: 3 }, fire.lastEventAt + MIN),
    ).toBeUndefined();
  });

  it('граница прохода — правка ЛЮБОГО разговора группы: работа правит, доставка гоняет гейт', () => {
    const ledgers = new GroupLedgers();
    const key = 'parent#1';
    ledgers.noteTreeEdit(key, 1_000);
    expect(ledgers.passOf(key, 500)).toBe(0);
    expect(ledgers.passOf(key, 2_000)).toBe(1_000);
    ledgers.noteTreeEdit(key, 3_000);
    expect(ledgers.passOf(key, 2_999)).toBe(1_000);
    expect(ledgers.passOf(key, 3_000)).toBe(3_000);
    // Чужая группа — свои правки.
    expect(ledgers.passOf('parent#2', 5_000)).toBe(0);
  });
});

describe('R4 не сбрасывает правка заметок (g1 26.10: `delivery` ×4)', () => {
  it('между запусками правился только ответ в .agent/ — круг, «внимание» с числом запусков', () => {
    const list = events('R4-notes-only/fire.jsonl');
    expect(hit(list, 'R4')).toMatchObject({ severity: 'warn', numbers: { runs: 4 } });
    expect(hit(list, 'R4', { settings: { checkRepeats: 5 } })).toBeUndefined();
  });

  it('между запусками правка кода — новый счёт, тишина', () => {
    expect(hit(events('R4-notes-only/near-miss.jsonl'), 'R4')).toBeUndefined();
  });

  it('файл вне своей копии тоже не код этой проверки; правка без пути — сброс', () => {
    const at = (t: number, name: string, input: Record<string, unknown>): WatchEvent => ({
      kind: 'tool',
      t,
      id: `${name}${t}`,
      name,
      input,
    });
    const check = 'pnpm test';
    const outside: WatchEvent[] = [
      at(0, 'Bash', { command: check }),
      at(MIN, 'Edit', { file_path: '/elsewhere/notes.ts' }),
      at(2 * MIN, 'Bash', { command: check }),
      at(3 * MIN, 'Bash', { command: check }),
    ];
    expect(hit(outside, 'R4')).toMatchObject({ numbers: { runs: 3 } });
    // Не .md, но под .agent/ своей копии — журнал кейсов, тоже заметки, не код.
    const agentJson = outside.map((event, i) =>
      i === 1
        ? at(MIN, 'Edit', { file_path: `${CWD}/.agent/tests/token-economy.tests.json` })
        : event,
    );
    expect(hit(agentJson, 'R4')).toMatchObject({ numbers: { runs: 3 } });
    const pathless = [...outside.slice(0, 3), at(150_000, 'Edit', {}), outside[3]!];
    expect(hit(pathless, 'R4')).toBeUndefined();
  });
});

describe('L2: запуск инструмента панели через переменную — работа, не R7 (#g5:400 27.10)', () => {
  const PANEL = '/work/panel';
  const bash = (command: string): WatchEvent[] => [
    { kind: 'tool', t: 0, id: 'b1', name: 'Bash', input: { command } },
  ];

  it('`T="node <панель>/tools/tests-cli.mjs"; $T run` — запуск, тишина', () => {
    const list = bash(`T="node ${PANEL}/tools/tests-cli.mjs"; $T run --project . --case g:1`);
    expect(hit(list, 'R7', { panelRoot: PANEL })).toBeUndefined();
  });

  it('чтение того же файла без node — R7', () => {
    const list = bash(`grep -n "run" ${PANEL}/tools/tests-cli.mjs`);
    expect(hit(list, 'R7', { panelRoot: PANEL })).toBeDefined();
  });
});

describe('R16 «шёл долго» (g0 25.10: pytest 156 с)', () => {
  it('вызов кончился через 156 с при пороге 120 — сведение со своим текстом', () => {
    const list = events('R16-slow/fire.jsonl');
    expect(hit(list, 'R16')).toMatchObject({
      severity: 'info',
      textKey: 'groupWatch.rule.R16slow',
      numbers: { ranMin: 3, calls: 1 },
    });
    expect(hit(list, 'R16', { settings: { slowSeconds: 160 } })).toBeUndefined();
    // Событие держится полчаса.
    expect(hit(list, 'R16', { now: end(list) + 31 * MIN })).toBeUndefined();
  });

  it('тот же набор за 100 с — тишина', () => {
    expect(hit(events('R16-slow/near-miss.jsonl'), 'R16')).toBeUndefined();
  });

  it('опыт очереди: вдвое дольше обычного — повод, в пределах двух обычных — нет', () => {
    const ctx = { settings: GROUP_WATCH_DEFAULTS };
    const tool: OpenTool = { name: 'Bash', startedAt: 0, label: 'pytest', expectMs: 100_000 };
    const state = createWatchState(0);
    noteEmbedResult(state, tool, { kind: 'toolResult', t: 156_000, id: 'x', chars: 1 }, ctx);
    expect(state.slowCalls ?? []).toHaveLength(0);
    noteEmbedResult(state, tool, { kind: 'toolResult', t: 201_000, id: 'x', chars: 1 }, ctx);
    expect(state.slowCalls).toEqual([
      { at: 201_000, ranMs: 201_000, expectMs: 100_000, label: 'pytest' },
    ]);
    // С опытом очереди — своя строка с «обычно»: без него подстановка осталась бы пустой.
    const node: WatchNode = { chatId: 'c1', groupIndex: 1, running: true, paused: false };
    const withExpect = evaluate(state, node, { ...ctx, cwd: CWD }, 202_000).find(
      (one) => one.rule === 'R16',
    );
    expect(withExpect).toMatchObject({
      textKey: 'groupWatch.rule.R16slowExpect',
      numbers: { ranMin: 3, expectMin: 2, calls: 1 },
    });
    // Субагент и вопрос человеку ждут по природе; отбитый стражем вызов не шёл вовсе.
    const quiet = createWatchState(0);
    const long = { kind: 'toolResult' as const, t: 600_000, id: 'x', chars: 1 };
    noteEmbedResult(quiet, { name: 'Agent', startedAt: 0 }, long, ctx);
    noteEmbedResult(quiet, { name: 'AskUserQuestion', startedAt: 0 }, long, ctx);
    noteEmbedResult(quiet, { name: 'Bash', startedAt: 0 }, { ...long, denied: 'gate-at-end' }, ctx);
    expect(quiet.slowCalls ?? []).toHaveLength(0);
  });
});

describe('R16 «фон долго» (g8 26.10: grep в фоне)', () => {
  it('фоновая задача без уведомления 21 мин — сведение; порог 30 — тишина', () => {
    const list = events('R16-background/fire.jsonl');
    const now = end(list) + 12 * MIN;
    expect(hit(list, 'R16', { now })).toMatchObject({
      severity: 'info',
      textKey: 'groupWatch.rule.R16bg',
      numbers: { openMin: 21 },
    });
    // Порог у самой границы: 21 мин при пороге 20 — ещё сведение, 30 — тишина.
    expect(hit(list, 'R16', { now, settings: { bgLongMinutes: 20 } })).toMatchObject({
      textKey: 'groupWatch.rule.R16bg',
    });
    expect(hit(list, 'R16', { now, settings: { bgLongMinutes: 30 } })).toBeUndefined();
    // Пауза группы — фон не судится; дольше двух часов — забытая запись, не работа.
    expect(hit(list, 'R16', { now, node: { paused: true } })).toBeUndefined();
    expect(hit(list, 'R16', { now: end(list) + 3 * 60 * MIN })).toBeUndefined();
  });

  it('остановлена вызовом TaskStop — запись закрыта сразу (ложный BGLONG через 13 мин)', () => {
    const list = events('R16-background/near-miss.jsonl');
    expect(hit(list, 'R16', { now: end(list) + 12 * MIN })).toBeUndefined();
  });

  it('уведомление CLI о конце задачи закрывает запись', () => {
    const list = events('R16-background/fire.jsonl');
    const done: WatchEvent = { kind: 'bgDone', t: end(list) + MIN, taskId: 'bgx41' };
    expect(hit([...list, done], 'R16', { now: end(list) + 12 * MIN })).toBeUndefined();
  });
});

describe('R37 длинная вводная (g1 27.10 00:40: 19k)', () => {
  it('вводная 19k при пороге 15k — сведение; порог 20k — тишина', () => {
    const list = events('R37-long-brief/fire.jsonl');
    expect(hit(list, 'R37')).toMatchObject({
      severity: 'info',
      numbers: { charsK: 19, limitK: 15 },
    });
    expect(hit(list, 'R37', { settings: { briefChars: 20_000 } })).toBeUndefined();
  });

  it('вводная 9.5k — тишина; уведомление о конце фоновой задачи вводной не считается', () => {
    expect(hit(events('R37-long-brief/near-miss.jsonl'), 'R37')).toBeUndefined();
    const read = createTranscriptReader();
    const notice = read({
      type: 'user',
      timestamp: '2026-10-27T00:41:00Z',
      message: {
        content: `<task-notification><task-id>b7</task-id><status>completed</status>${'x'.repeat(20_000)}</task-notification>`,
      },
    });
    expect(notice).toEqual([
      { kind: 'bgDone', t: Date.parse('2026-10-27T00:41:00Z'), taskId: 'b7', status: 'completed' },
      { kind: 'start', t: Date.parse('2026-10-27T00:41:00Z') },
    ]);
  });
});

describe('R44 признание пропуска в итоге хода', () => {
  const withEnd = (list: WatchEvent[]): WatchEvent[] => [
    ...list,
    { kind: 'end', t: end(list) + 1000 },
  ];

  it('g1 27.10 00:43: «three sieves were not checked» — сведение со словами и выдержкой', () => {
    const list = withEnd(events('R44-admission/fire.jsonl'));
    const found = hit(list, 'R44');
    expect(found).toMatchObject({ severity: 'info', params: { phrase: 'not checked' } });
    expect(found?.params?.excerpt).toContain('Three sieves were not checked');
    expect(hit(list, 'R44', { now: end(list) + 31 * MIN })).toBeUndefined();
  });

  it('g1 26.10 20:03: «not run» внутри строки журнала в обратных кавычках — тишина', () => {
    expect(hit(withEnd(events('R44-admission/near-miss.jsonl')), 'R44')).toBeUndefined();
  });

  it('ход не кончился — итога ещё нет, судить нечего', () => {
    expect(hit(events('R44-admission/fire.jsonl'), 'R44')).toBeUndefined();
  });
});

describe('BURN: два круга в одном ходе — тревога (g1 26.10 ~21:05)', () => {
  it('проверка по кругу и опрос со сном в одном ходе — новее из них тревога', () => {
    const list = events('BURN-two-loops/fire.jsonl');
    const state = fold(list);
    const hits = judge(list);
    escalateBurn(hits, state.turnAt);
    expect(hits.find((one) => one.rule === 'R4')?.severity).toBe('warn');
    expect(hits.find((one) => one.rule === 'R11')?.severity).toBe('alert');
  });

  it('круги в разных ходах — каждый своё «внимание»', () => {
    const list = events('BURN-two-loops/near-miss.jsonl');
    const state = fold(list);
    const hits = judge(list);
    escalateBurn(hits, state.turnAt);
    expect(hits.map((one) => [one.rule, one.severity])).toEqual([
      ['R4', 'warn'],
      ['R11', 'warn'],
    ]);
  });

  it('R21 группы — тоже круг хода; один круг — не BURN; без начала хода — не судим', () => {
    const r4: RuleHit = { rule: 'R4', severity: 'warn', numbers: {}, since: 200 };
    const r21: RuleHit = { rule: 'R21', severity: 'warn', numbers: {}, since: 300 };
    escalateBurn([r4, r21], 100);
    expect([r4.severity, r21.severity]).toEqual(['warn', 'alert']);
    const lone: RuleHit = { rule: 'R4', severity: 'warn', numbers: {}, since: 200 };
    escalateBurn([lone], 100);
    expect(lone.severity).toBe('warn');
    const a: RuleHit = { rule: 'R4', severity: 'warn', numbers: {}, since: 200 };
    const b: RuleHit = { rule: 'R11', severity: 'warn', numbers: {}, since: 300 };
    escalateBurn([a, b], undefined);
    expect(b.severity).toBe('warn');
  });
});

describe('R45 D-n, который панель не разрешила сама', () => {
  const T0 = Date.parse('2026-10-26T18:00:00Z');
  const sweep = (
    stuck: { id: string; tool: string; at: number } | undefined,
    status: SplitPlanGroupRecord['status'] = 'started',
  ) =>
    sweepGroups({
      plans: { parent: { groups: [{ index: 1, title: 'g', status } as SplitPlanGroupRecord] } },
      live: () => ({ running: false, ask: stuck !== undefined, queued: false, paused: false }),
      deferredStuck: () => stuck,
      lastSeen: new Map(),
      nudgeSnap: new Map(),
      settings: GROUP_WATCH_DEFAULTS,
      now: T0 + 12 * MIN,
      bornAt: T0,
    })[0]?.hits ?? [];

  it('ждущий `not-auto-approved` — сведение с номером и инструментом; R22 молчит', () => {
    const hits = sweep({ id: 'D-7', tool: 'Bash', at: T0 });
    expect(hits).toEqual([
      {
        rule: 'R45',
        severity: 'info',
        numbers: { waitMin: 12 },
        params: { id: 'D-7', tool: 'Bash' },
        since: T0,
      },
    ]);
  });

  it('нет такого D-n — тишина; группа на паузе — тишина', () => {
    expect(sweep(undefined).filter((one) => one.rule === 'R45')).toEqual([]);
    expect(sweep({ id: 'D-7', tool: 'Bash', at: T0 }, 'paused')).toEqual([]);
  });
});

describe('вид беды внутри правила меняет строку сигнала на месте', () => {
  it('R16 «открыт долго» → «шёл долго»: тот же сигнал, новый ключ текста, правка строки', () => {
    const scope = { chatId: 'c1', groupIndex: 1 };
    const open: RuleHit = { rule: 'R16', severity: 'info', numbers: { openMin: 12 }, since: 0 };
    const first = mergeSignals([], scope, [open], 1000, () => 's1');
    expect(first.signals[0]?.textKey).toBe('groupWatch.rule.R16');
    const slow: RuleHit = {
      rule: 'R16',
      severity: 'info',
      numbers: { ranMin: 14 },
      since: 0,
      textKey: 'groupWatch.rule.R16slow',
    };
    const second = mergeSignals(first.signals, scope, [slow], 2000, () => 's2');
    const signal = second.signals[0] as GroupSignal;
    expect(signal).toMatchObject({ id: 's1', textKey: 'groupWatch.rule.R16slow' });
    expect(second.numbers).toBe(true);
  });
});
