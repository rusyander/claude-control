import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import {
  createLimitRunsReader,
  limitJournalPath,
  windowPointsOf,
  type LimitRunRecord,
} from '../../../limit-journal/limit-journal.ts';
import { accountProjection, type LimitPoint } from '../rules.ts';
import { streamWatchEvents } from '../stream-events.ts';
import {
  accountWindow,
  finishedRuns,
  heavyRunHit,
  heavyRuns,
  weekProjection,
  windowLevel,
} from './window-rules.ts';

/**
 * Окно подписки: R9 — прогноз пятичасового окна, уровни 80/90/95 % обоих окон, прогноз
 * недели; R42 — тяжёлый прогон. Вырезки `__fixtures__/leak/R9-window`, `R42-heavy-run` —
 * записи `limit-runs.json`, собранные руками по строкам журнала наблюдателя (g1 26.10
 * ложные «+49 %», 25.10 открытая запись как конец прогона, g9 26.10 ключи `new-…`).
 */

const T = (hms: string): number => Date.parse(`2026-10-26T${hms}Z`);
const S = (hms: string): number => T(hms) / 1000;
const NOW = T('10:45:00');
const MIN = 60_000;
const runs = (name: string): LimitRunRecord[] =>
  JSON.parse(
    readFileSync(new URL(`../__fixtures__/leak/${name}`, import.meta.url), 'utf8'),
  ) as LimitRunRecord[];
const settings = GROUP_WATCH_DEFAULTS;
const five = (t: number, utilization: number, resetsAt = S('15:00:00')): LimitPoint => ({
  t,
  utilization,
  resetsAt,
});
const week = (t: number, utilization: number, resetsAt: number): LimitPoint => ({
  ...five(t, utilization, resetsAt),
  week: true,
});
const WEEK_RESET = Date.parse('2026-10-30T08:00:00Z') / 1000;

describe('R9 уровни окна: 80/90/95 % любого из двух окон', () => {
  it('вырезка fire: пятичасовое ровно на 82 %, недельное на 91 % — сведение по недельному, уровень 90', () => {
    const hit = accountWindow(windowPointsOf(runs('R9-window/fire.json')), settings, NOW);
    expect(hit).toEqual({
      rule: 'R9',
      severity: 'info',
      numbers: { nowPct: 91, levelPct: 90, resetHours: 93 },
      since: T('10:40:00'),
      textKey: 'groupWatch.rule.R9levelWeek',
    });
  });

  it('вырезка near-miss: 97 % окна, сброшенного в 10:30, — история; пятичасовое на 79 % — тишина', () => {
    expect(accountWindow(windowPointsOf(runs('R9-window/near-miss.json')), settings, NOW)).toBe(
      undefined,
    );
  });

  it('уровень растёт на месте: 80 → 90 → 95; ниже 80 — тишина; равные — пятичасовое', () => {
    const at = (share: number) => windowLevel([five(T('10:40:00'), share)], NOW)?.numbers.levelPct;
    expect(at(0.79)).toBeUndefined();
    expect(at(0.8)).toBe(80);
    expect(at(0.94)).toBe(90);
    expect(at(0.95)).toBe(95);
    const tie = windowLevel(
      [five(T('10:40:00'), 0.85), week(T('10:40:00'), 0.88, WEEK_RESET)],
      NOW,
    );
    expect(tie).toMatchObject({
      textKey: 'groupWatch.rule.R9level',
      numbers: { nowPct: 85, levelPct: 80, resetMin: 255 },
    });
  });

  it('уровень — по последнему замеру окна, а не по самому высокому', () => {
    const hit = windowLevel(
      [five(T('10:00:00'), 0.96), five(T('10:40:00'), 0.5, S('20:00:00'))],
      NOW,
    );
    expect(hit).toBeUndefined();
  });
});

describe('R9 прогноз: пятичасовое окно первым, неделя — по всему окну', () => {
  it('пятичасовое растёт к 100 % к сбросу — прежний R9 «внимание» поверх пройденного уровня', () => {
    const hit = accountWindow(
      [five(T('10:20:00'), 0.8), five(T('10:40:00'), 0.86), week(T('10:40:00'), 0.92, WEEK_RESET)],
      settings,
      NOW,
    );
    expect(hit).toMatchObject({ rule: 'R9', severity: 'warn', numbers: { nowPct: 86 } });
    expect(hit?.textKey).toBeUndefined();
  });

  it('недельные замеры пятичасового прогноза не трогают', () => {
    expect(
      accountProjection(
        [week(T('10:20:00'), 0.1, WEEK_RESET), week(T('10:40:00'), 0.6, WEEK_RESET)],
        settings,
        NOW,
      ),
    ).toBeUndefined();
  });

  it('неделя: 30 → 50 % за 7 ч при сбросе через 93 ч — к сбросу больше 90 %; базис 5 ч 59 мин — тишина', () => {
    const points = [week(T('03:40:00'), 0.3, WEEK_RESET), week(T('10:40:00'), 0.5, WEEK_RESET)];
    expect(weekProjection(points, settings, NOW)).toMatchObject({
      rule: 'R9',
      severity: 'info',
      numbers: { nowPct: 50, resetHours: 93 },
      since: T('03:40:00'),
      textKey: 'groupWatch.rule.R9week',
    });
    const short = [week(T('04:41:00'), 0.3, WEEK_RESET), week(T('10:40:00'), 0.5, WEEK_RESET)];
    expect(weekProjection(short, settings, NOW)).toBeUndefined();
    // Замер прошлого недельного окна в базис не входит.
    const old = [week(T('03:40:00'), 0.3, S('09:00:00')), week(T('10:40:00'), 0.5, WEEK_RESET)];
    expect(weekProjection(old, settings, NOW)).toBeUndefined();
  });

  it('живой замер потока несёт и недельное окно', () => {
    const sample = {
      at: T('10:40:00'),
      fiveHour: { utilization: 0.4, resetsAt: S('15:00:00') },
      sevenDay: { utilization: 0.6, resetsAt: WEEK_RESET },
    };
    const events = streamWatchEvents(
      { kind: 'limit', resetsAt: S('15:00:00'), type: 'five_hour', status: 'allowed', sample },
      T('10:40:00'),
    );
    expect(events).toEqual([
      { kind: 'limit', t: T('10:40:00'), utilization: 0.4, resetsAt: S('15:00:00') },
      { kind: 'limit', t: T('10:40:00'), utilization: 0.6, resetsAt: WEEK_RESET, week: true },
    ]);
  });
});

describe('R42 тяжёлый прогон', () => {
  it('вырезка fire: прогон сдвинул окно на 8 %, следующий съел 3,4 млн; открытая запись — не конец', () => {
    const list = heavyRuns(runs('R42-heavy-run/fire.json'), settings, NOW);
    expect(
      list.map((run) => [
        run.id,
        Math.round((run.five ?? 0) * 100),
        Math.round((run.seven ?? 0) * 100),
      ]),
    ).toEqual([
      ['r-b', 8, 2],
      ['r-c', 2, 0],
    ]);
    expect(heavyRunHit(list)).toEqual({
      rule: 'R42',
      severity: 'info',
      numbers: { runs: 2, mTokens: 3.4, runMin: 19, fivePct: 2, weekPct: 0 },
      since: T('10:40:00'),
      textKey: 'groupWatch.rule.R42',
    });
  });

  it('вырезка overlap: группы идут вместе — опора не позже начала прогона, а не конец соседа', () => {
    // Журнал, каким его прочёл сторож 27.10 в 19:29 (+05): три законченных прогона и открытый
    // следующий g9. Опора на последний замер соседа давала g1 «+1 %» при 9 → 20 %, g5 «+0 %» при 9 → 22 %.
    const list = finishedRuns(
      runs('R42-heavy-run/overlap.json'),
      Date.parse('2026-10-27T14:29:07Z'),
    );
    expect(list.map((run) => [run.id, Math.round((run.five ?? 0) * 100)])).toEqual([
      ['r-g9', 10],
      ['r-g1', 11],
      ['r-g5', 13],
    ]);
  });

  it('вырезка near-miss: опора из сброшенного окна часовой давности — не «+49 %»; на шаг под порогами; давний и открытый — тишина', () => {
    const list = heavyRuns(runs('R42-heavy-run/near-miss.json'), settings, NOW);
    // Тяжёлый только одиночный чат: к группе его не отнесёт сторож.
    expect(list.map((run) => run.id)).toEqual(['r-e']);
    expect(list[0]?.chatId).toBe('chat-solo');
  });

  it('пороги — из настроек: 2,9 млн при пороге 2,9 млн и +4 % при пороге 4 — тяжёлый', () => {
    const near = runs('R42-heavy-run/near-miss.json');
    const ids = (over: Partial<typeof settings>) =>
      heavyRuns(near, { ...settings, ...over }, NOW).map((run) => run.id);
    expect(ids({ heavyRunTokens: 2_900_000 })).toContain('r-d');
    expect(ids({ heavyRunPercent: 4 })).toContain('r-d');
    expect(ids({ heavyRunWeekPercent: 1 })).toContain('r-d');
    expect(ids({ heavyRunPercent: 3 })).toEqual(['r-b', 'r-d', 'r-e']);
  });

  it('доля — до десятой процента: 30 → 35 % и 28 → 30 % недели — ровно на порогах, а не 4,99… и 1,99…', () => {
    const run: LimitRunRecord = {
      id: 'r-y',
      chatId: 'child-3',
      startedAt: T('10:00:00'),
      endedAt: T('10:30:00'),
      tokens: 100_000,
      samples: [
        {
          at: T('10:00:00'),
          fiveHour: { utilization: 0.3, resetsAt: S('15:00:00') },
          sevenDay: { utilization: 0.28, resetsAt: WEEK_RESET },
        },
        {
          at: T('10:30:00'),
          fiveHour: { utilization: 0.35, resetsAt: S('15:00:00') },
          sevenDay: { utilization: 0.28, resetsAt: WEEK_RESET },
        },
      ],
    };
    expect(heavyRuns([run], settings, NOW).map((one) => one.id)).toEqual(['r-y']);
    const weekOnly = structuredClone(run);
    weekOnly.samples[1]!.fiveHour!.utilization = 0.31;
    weekOnly.samples[1]!.sevenDay!.utilization = 0.3;
    expect(heavyRuns([weekOnly], settings, NOW).map((one) => one.id)).toEqual(['r-y']);
  });

  it('держится полчаса после конца прогона', () => {
    const fire = runs('R42-heavy-run/fire.json');
    const end = T('10:40:00');
    expect(heavyRuns(fire, settings, end + 30 * MIN).map((run) => run.id)).toEqual(['r-c']);
    expect(heavyRuns(fire, settings, end + 30 * MIN + 1)).toEqual([]);
  });

  it('окно не мерилось — строка только о токенах, без «+0 %»', () => {
    const lone: LimitRunRecord = {
      id: 'r-x',
      chatId: 'child-3',
      startedAt: T('10:00:00'),
      endedAt: T('10:30:00'),
      tokens: 3_000_000,
      samples: [],
    };
    const hit = heavyRunHit(heavyRuns([lone], settings, NOW));
    expect(hit).toMatchObject({
      textKey: 'groupWatch.rule.R42tokens',
      numbers: { runs: 1, mTokens: 3, runMin: 30 },
    });
    expect(hit?.numbers).not.toHaveProperty('fivePct');
    expect(heavyRunHit([])).toBeUndefined();
  });
});

describe('журнал лимита одним читателем', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('тот же список, пока файл не изменился; замеры обоих окон с отметкой недели', () => {
    dir = mkdtempSync(join(tmpdir(), 'limit-runs-'));
    const read = createLimitRunsReader(dir);
    expect(read()).toEqual([]);
    writeFileSync(limitJournalPath(dir), JSON.stringify(runs('R9-window/fire.json')));
    const first = read();
    expect(read()).toBe(first);
    const points = windowPointsOf(first);
    expect(points.filter((point) => point.week)).toHaveLength(2);
    expect(points.filter((point) => !point.week)).toHaveLength(2);
    writeFileSync(limitJournalPath(dir), JSON.stringify(runs('R42-heavy-run/fire.json')));
    expect(read()).not.toBe(first);
    expect(read()).toHaveLength(4);
  });
});
