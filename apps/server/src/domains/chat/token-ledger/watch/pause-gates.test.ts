import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate, groupBurn, groupGates, type BurnPoint, type GatePoint } from './rules.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { WatchEvent, WatchNode, WatchState } from './watch.types.ts';

/**
 * Пропуски сторожа прогона 23.10 (план d9869abf) на вырезках НАСТОЯЩИХ транскриптов,
 * обезличенных (`__fixtures__/leak/R20-…`, `R21-…`): строка транскрипта → читатель →
 * свёртка → правила.
 *
 * - R20: группа #8 стояла на паузе с 08:13:12, а в 08:17:03 фоновая задача разбудила
 *   CLI — коммит, worktree, карточка прав. Ни одного сигнала.
 * - R21: группа #9 за 1 ч 45 мин прогнала полный гейт пять раз (21.4, 20.5, 7.3, 9.8,
 *   14.3 мин) с правками между — R4 молчал: правка сбрасывает его счёт.
 * - R8: расход у порога 40 W/ч мигал — 13 сигналов за 6 минут у #8.
 */

const MIN = 60_000;
const PAUSED_AT = Date.parse('2026-10-23T08:13:12Z');

function events(name: string): WatchEvent[] {
  const read = createTranscriptReader();
  return readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => read(JSON.parse(line) as unknown));
}

function fold(list: readonly WatchEvent[], settings: Partial<GroupWatch> = {}): WatchState {
  const ctx = { settings: { ...GROUP_WATCH_DEFAULTS, ...settings } };
  const state = createWatchState(list[0]?.t ?? 0);
  for (const event of list) reduce(state, event, ctx);
  return state;
}

const node = (over: Partial<WatchNode> = {}): WatchNode => ({
  chatId: 'c1',
  groupIndex: 8,
  running: false,
  paused: true,
  pausedAt: PAUSED_AT,
  ...over,
});

describe('R20 группа действует на паузе', () => {
  const list = events('R20-paused-activity/fire.jsonl');
  const state = fold(list);
  const now = list.at(-1)?.t ?? 0;
  const settings = { settings: GROUP_WATCH_DEFAULTS };

  it('#8: проснулась через 4 мин после паузы и сделала 15 вызовов — тревога', () => {
    const hits = evaluate(state, node(), settings, now);
    expect(hits.map((hit) => hit.rule)).toEqual(['R20']);
    expect(hits[0]).toMatchObject({
      severity: 'alert',
      numbers: { tools: 15, afterMin: 4 },
      since: Date.parse('2026-10-23T08:17:03.205Z'),
    });
    // Последний вызов на паузе — снос worktree; строка обрезана, как у прочих правил (160 знаков).
    expect(hits[0]?.params?.call).toMatch(/combocheck.*git worktree rem…$/);
  });

  it('пауза позже последнего события, группа не на паузе — тишина', () => {
    expect(evaluate(state, node({ pausedAt: now + MIN }), settings, now)).toEqual([]);
    const running = evaluate(state, node({ paused: false, running: true }), settings, now);
    expect(running.map((hit) => hit.rule)).not.toContain('R20');
  });

  it('последние секунды хода до остановки — не утечка: вызовы в первую минуту паузы не в счёт', () => {
    const tail = createWatchState(PAUSED_AT);
    const ctx = { settings: GROUP_WATCH_DEFAULTS };
    reduce(tail, { kind: 'tool', t: PAUSED_AT + 20_000, id: 'x', name: 'Bash', input: {} }, ctx);
    expect(evaluate(tail, node(), ctx, PAUSED_AT + 2 * MIN)).toEqual([]);
  });

  it('на паузе прочие правила сессии молчат: условие их уже не действует', () => {
    const r1b = evaluate(state, node({ ask: { since: now - 60 * MIN } }), settings, now);
    expect(r1b.map((hit) => hit.rule)).toEqual(['R20']);
  });
});

describe('R21 тяжёлые проверки по кругу', () => {
  const list = events('R21-heavy-checks/fire.jsonl');

  it('#9: пять полных гейтов дольше 3 мин; короткие (сборка 1.3 мин, повтор из журнала) не в счёт', () => {
    const state = fold(list);
    expect(state.heavyChecks.map((check) => Math.round(check.minutes * 10) / 10)).toEqual([
      21.4, 20.5, 7.3, 9.8, 14.3,
    ]);
    // Порог 10 мин — три; 25 мин — ни одной.
    expect(fold(list, { heavyCheckMinutes: 10 }).heavyChecks).toHaveLength(3);
    expect(fold(list, { heavyCheckMinutes: 25 }).heavyChecks).toHaveLength(0);
  });

  it('R4 те же гейты не видит: между запусками правки', () => {
    const state = fold(list);
    const hits = evaluate(
      state,
      node({ paused: false, running: true }),
      {
        settings: GROUP_WATCH_DEFAULTS,
      },
      list.at(-1)?.t ?? 0,
    );
    expect(hits.map((hit) => hit.rule)).not.toContain('R4');
  });

  it('группа: пять гейтов за окно — «внимание»; порог 6 — тишина; через полчаса после последнего — закрыт', () => {
    const state = fold(list);
    const points: GatePoint[] = state.heavyChecks.map((check) => ({ ...check, chatId: 'c1' }));
    const last = points.at(-1)?.endedAt ?? 0;
    const hit = groupGates(points, GROUP_WATCH_DEFAULTS, last + MIN);
    expect(hit).toMatchObject({
      rule: 'R21',
      severity: 'warn',
      numbers: { gates: 5, totalMin: 73 },
    });
    expect(hit?.params?.command).toContain('check_frontend_tests');
    expect(
      groupGates(points, { ...GROUP_WATCH_DEFAULTS, gateRepeats: 6 }, last + MIN),
    ).toBeUndefined();
    expect(groupGates(points, GROUP_WATCH_DEFAULTS, last + 31 * MIN)).toBeUndefined();
    // Один гейт — тот самый финальный: не сигнал.
    expect(groupGates(points.slice(0, 1), GROUP_WATCH_DEFAULTS, last + MIN)).toBeUndefined();
  });
});

describe('R8 у порога не мигает', () => {
  const settings = GROUP_WATCH_DEFAULTS;
  // Окно 15 мин, порог 40 W/ч = 10 W в окне.
  const points: BurnPoint[] = [
    { t: 0, weight: 3.4 },
    { t: MIN, weight: 3.4 },
    { t: 2 * MIN, weight: 3.4 },
    { t: 16 * MIN, weight: 3.1 },
  ];

  it('поднятый держится, пока расход не упал заметно ниже порога (39.6 W/ч — ещё горит)', () => {
    expect(groupBurn(points, settings, 16 * MIN)).toBeUndefined();
    expect(groupBurn(points, settings, 16 * MIN, true)).toMatchObject({
      rule: 'R8',
      numbers: { perHour: 39.6 },
    });
  });

  it('упал ниже 85 % порога — закрыт и у поднятого', () => {
    const low = [...points, { t: 17 * MIN, weight: 0.1 }];
    // В окне 17 мин: 3.4 (2 мин) + 3.1 + 0.1 = 6.6 W → 26.4 W/ч.
    expect(groupBurn(low, settings, 17 * MIN, true)).toBeUndefined();
  });
});
