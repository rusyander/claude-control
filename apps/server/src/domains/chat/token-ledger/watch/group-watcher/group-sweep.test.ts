import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import type { GroupLive } from './group-watcher.types.ts';
import { sweepGroups, type NudgeSnap, type SeenMark } from './group-sweep.ts';

/**
 * Правила группы R22 (стоит без хода) и R28 (напоминания о доставке не двигают её):
 * чистый обход записей разделения. Живость группы и затравка тишины — подменённые
 * ответы проводки; всё остальное — настоящая функция.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-23T10:00:00Z');
const IDLE: GroupLive = { running: false, ask: false, queued: false, paused: false };

function run(
  group: Partial<SplitPlanGroupRecord>,
  options: {
    now?: number;
    live?: Partial<GroupLive>;
    lastSeen?: Map<string, SeenMark>;
    nudgeSnap?: Map<string, NudgeSnap>;
    seenAt?: number;
    settings?: Partial<GroupWatch>;
    noLive?: boolean;
  } = {},
) {
  const record = { index: 1, title: 'g', status: 'started', ...group } as SplitPlanGroupRecord;
  const lastSeen = options.lastSeen ?? new Map<string, SeenMark>([['parent#1', { at: T0 }]]);
  const swept = sweepGroups({
    plans: { parent: { groups: [record] } },
    ...(options.noLive ? {} : { live: () => ({ ...IDLE, ...options.live }) }),
    ...(options.seenAt !== undefined ? { seenAt: () => options.seenAt } : {}),
    lastSeen,
    nudgeSnap: options.nudgeSnap ?? new Map(),
    settings: { ...GROUP_WATCH_DEFAULTS, ...options.settings },
    now: options.now ?? T0 + 25 * MIN,
    bornAt: T0 - 120 * MIN,
  });
  return { hits: swept[0]?.hits ?? [], lastSeen, swept };
}

const rule = <T extends { rule: string }>(hits: readonly T[], name: string): T | undefined =>
  hits.find((hit) => hit.rule === name);

describe('sweepGroups R22 группа стоит без хода', () => {
  it('started, ни прогона, ни вопроса, ни очереди, тишина 25 мин — внимание; 65 мин — тревога', () => {
    expect(rule(run({}).hits, 'R22')).toMatchObject({
      severity: 'warn',
      numbers: { idleMin: 25 },
      params: { why: 'no-run' },
      since: T0,
    });
    expect(rule(run({}, { now: T0 + 65 * MIN }).hits, 'R22')).toMatchObject({
      severity: 'alert',
      numbers: { idleMin: 65 },
    });
    // Порог читается: 30 мин — 25 мин тишины ещё не повод.
    expect(rule(run({}, { settings: { silentStopMinutes: 30 } }).hits, 'R22')).toBeUndefined();
    expect(rule(run({}, { now: T0 + 19 * MIN }).hits, 'R22')).toBeUndefined();
  });

  it('прогон, вопрос, очередь, пауза дерева, отложенное продолжение — молчит, а часы тишины идут с этого тика', () => {
    for (const live of [{ running: true }, { ask: true }, { queued: true }, { paused: true }]) {
      const { hits, lastSeen } = run({}, { live });
      expect(rule(hits, 'R22')).toBeUndefined();
      expect(lastSeen.get('parent#1')?.at).toBe(T0 + 25 * MIN);
    }
    const later = new Date(T0 + 60 * MIN).toISOString();
    for (const group of [
      { parked: { prompt: 'дальше', at: new Date(T0).toISOString() } },
      { continueQueuedAt: new Date(T0).toISOString() },
      { limitUntil: later },
      { blockedSince: new Date(T0).toISOString() },
    ]) {
      expect(rule(run(group).hits, 'R22')).toBeUndefined();
    }
    // Срок лимита прошёл — ждать больше нечего.
    expect(rule(run({ limitUntil: new Date(T0).toISOString() }).hits, 'R22')).toBeDefined();
  });

  it('повтор доставки панелью назначен — молчит; повтор отработал (срока нет) — снова судит', () => {
    const waiting = {
      status: 'awaiting' as const,
      waitingFor: 'delivery' as const,
      deliveryRetry: {
        count: 1,
        at: new Date(T0 + 30 * MIN).toISOString(),
        kind: 'verify' as const,
      },
    };
    expect(rule(run(waiting).hits, 'R22')).toBeUndefined();
    expect(
      rule(run({ ...waiting, deliveryRetry: { count: 1, kind: 'verify' } }).hits, 'R22'),
    ).toBeDefined();
  });

  it('пауза группы, очередь до старта, конец — не правило группы; решение человека на карточке — тоже ожидание', () => {
    for (const status of ['paused', 'pending', 'waiting', 'held'] as const) {
      const { hits, lastSeen } = run({ status });
      expect(hits).toEqual([]);
      expect(lastSeen.get('parent#1')?.at).toBe(T0 + 25 * MIN);
    }
    expect(run({ status: 'done' }).swept).toEqual([]);
    expect(rule(run({ status: 'awaiting', waitingFor: 'decision' }).hits, 'R22')).toBeUndefined();
  });

  it('почему стоит: подхват без конца хода или оборванный ход — перезапуск; awaiting без вопроса — ждёт ответа', () => {
    const detached = new Map<string, SeenMark>([['parent#1', { at: T0, detached: true }]]);
    expect(rule(run({}, { lastSeen: detached }).hits, 'R22')?.params).toEqual({ why: 'restart' });
    expect(rule(run({ interruptedAt: new Date(T0).toISOString() }).hits, 'R22')?.params).toEqual({
      why: 'restart',
    });
    expect(rule(run({ status: 'awaiting', waitingFor: 'question' }).hits, 'R22')?.params).toEqual({
      why: 'awaiting',
    });
  });

  it('после перезапуска метки нет: тишина — от последней записи переписки, иначе от старта группы', () => {
    const empty = () => new Map<string, SeenMark>();
    const fromFile = run({}, { lastSeen: empty(), seenAt: T0 - 10 * MIN });
    expect(rule(fromFile.hits, 'R22')?.numbers).toEqual({ idleMin: 35 });
    // Затравка легла в память: следующий тик файл не читает.
    expect(fromFile.lastSeen.get('parent#1')).toEqual({ at: T0 - 10 * MIN });
    const fromStart = run(
      { startedAt: new Date(T0 + 10 * MIN).toISOString() },
      { lastSeen: empty() },
    );
    expect(rule(fromStart.hits, 'R22')).toBeUndefined();
  });

  it('решение человека 40 мин, потом принято: часы тишины — от решения, не от последнего хода (F-53)', () => {
    const lastSeen = new Map<string, SeenMark>([['parent#1', { at: T0 }]]);
    const waiting = { status: 'awaiting' as const, waitingFor: 'decision' as const };
    for (const minute of [10, 25, 40]) {
      expect(run(waiting, { lastSeen, now: T0 + minute * MIN }).hits).toEqual([]);
    }
    // Решение принято, ход ещё не начался: тишина — минута, не 41.
    expect(rule(run({}, { lastSeen, now: T0 + 41 * MIN }).hits, 'R22')).toBeUndefined();
    expect(rule(run({}, { lastSeen, now: T0 + 65 * MIN }).hits, 'R22')).toMatchObject({
      severity: 'warn',
      numbers: { idleMin: 25 },
    });
  });

  it('без живости группы (проводки нет) R22 молчит: судить не по чему', () => {
    expect(rule(run({}, { noLive: true }).hits, 'R22')).toBeUndefined();
  });

  it('память ограничена живыми группами: кончившаяся группа уходит из меток', () => {
    const lastSeen = new Map<string, SeenMark>([
      ['parent#1', { at: T0 }],
      ['gone#3', { at: T0 }],
    ]);
    run({ status: 'done' }, { lastSeen });
    expect([...lastSeen.keys()]).toEqual([]);
  });
});

describe('sweepGroups R28 напоминания о доставке не двигают её', () => {
  const round = (minute: number, missing: string[]) => ({
    at: new Date(T0 + minute * MIN).toISOString(),
    missing,
  });

  it('два напоминания, не хватает всё того же — внимание с первым пробелом и числом напоминаний', () => {
    const missing = ['MR не открыт: ветка не запушена в origin', 'живая проверка не записана'];
    const { hits } = run({
      deliveryNudges: 2,
      deliveryMissing: missing,
      deliveryHistory: [round(1, [...missing].reverse()), round(5, missing)],
    });
    expect(rule(hits, 'R28')).toMatchObject({
      severity: 'warn',
      numbers: { nudges: 2 },
      params: { missing: 'MR не открыт: ветка не запушена в origin' },
      since: T0 + 5 * MIN,
    });
  });

  it('набор сдвинулся между напоминаниями — не застой; порог напоминаний читается', () => {
    const moved = run({
      deliveryNudges: 2,
      deliveryMissing: ['б'],
      deliveryHistory: [round(1, ['а', 'б']), round(5, ['б'])],
    });
    expect(rule(moved.hits, 'R28')).toBeUndefined();
    const same = {
      deliveryNudges: 2,
      deliveryMissing: ['а'],
      deliveryHistory: [round(1, ['а']), round(5, ['а'])],
    };
    expect(rule(run(same).hits, 'R28')).toBeDefined();
    expect(rule(run(same, { settings: { nudgeRepeats: 3 } }).hits, 'R28')).toBeUndefined();
  });

  it('журнала доставки нет (старая запись): наборы — из того, что сторож видел при росте счётчика', () => {
    const nudgeSnap = new Map<string, NudgeSnap>();
    const first = run({ deliveryNudges: 1, deliveryMissing: ['а'] }, { nudgeSnap });
    expect(rule(first.hits, 'R28')).toBeUndefined();
    const second = run({ deliveryNudges: 2, deliveryMissing: ['а'] }, { nudgeSnap });
    // Первое напоминание сторож застал уже случившимся: его набор неизвестен — ждём ещё одно.
    expect(rule(second.hits, 'R28')).toBeUndefined();
    const third = run({ deliveryNudges: 3, deliveryMissing: ['а'] }, { nudgeSnap });
    expect(rule(third.hits, 'R28')).toMatchObject({ numbers: { nudges: 3 } });
  });

  it('пауза: прежние напоминания — прошлое; после снятия R28 ждёт нового напоминания (F-51)', () => {
    const nudgeSnap = new Map<string, NudgeSnap>();
    const stuck = {
      deliveryNudges: 2,
      deliveryMissing: ['а'],
      deliveryHistory: [round(1, ['а']), round(5, ['а'])],
    };
    expect(rule(run(stuck, { nudgeSnap, now: T0 + 10 * MIN }).hits, 'R28')).toBeDefined();
    // Пауза группы и пауза дерева (статус прежний, живость — на паузе).
    expect(run({ ...stuck, status: 'paused' }, { nudgeSnap, now: T0 + 20 * MIN }).hits).toEqual([]);
    expect(rule(run(stuck, { nudgeSnap, now: T0 + 25 * MIN }).hits, 'R28')).toBeUndefined();
    const tree = new Map<string, NudgeSnap>();
    expect(
      run(stuck, { nudgeSnap: tree, now: T0 + 20 * MIN, live: { paused: true } }).hits,
    ).toEqual([]);
    expect(rule(run(stuck, { nudgeSnap: tree, now: T0 + 25 * MIN }).hits, 'R28')).toBeUndefined();
    // Новое напоминание после паузы с тем же пробелом — одно, застоя ещё нет; второе — есть.
    const once = {
      ...stuck,
      deliveryNudges: 3,
      deliveryHistory: [...stuck.deliveryHistory, round(30, ['а'])],
    };
    expect(rule(run(once, { nudgeSnap, now: T0 + 31 * MIN }).hits, 'R28')).toBeUndefined();
    const twice = {
      ...once,
      deliveryNudges: 4,
      deliveryHistory: [...once.deliveryHistory, round(35, ['а'])],
    };
    expect(rule(run(twice, { nudgeSnap, now: T0 + 36 * MIN }).hits, 'R28')).toMatchObject({
      numbers: { nudges: 4 },
    });
  });

  it('напоминание ушло в разговор ревью, а доставка впереди — сразу, с первого раза', () => {
    const base = { deliveryNudges: 1, deliveryMissing: ['пуш'], deliver: true };
    expect(rule(run({ ...base, deliveryNudgeStage: 'review' }).hits, 'R28')).toMatchObject({
      numbers: { nudges: 1 },
    });
    // Разговор доставки — его работа и есть пуш: не повод.
    expect(rule(run({ ...base, deliveryNudgeStage: 'deliver' }).hits, 'R28')).toBeUndefined();
    // Разговор плана MR тоже не откроет — только чтение (F-116).
    expect(rule(run({ ...base, deliveryNudgeStage: 'plan' }).hits, 'R28')).toMatchObject({
      numbers: { nudges: 1 },
    });
    // Доставки у группы нет — пуш и правда в работе.
    expect(
      rule(run({ ...base, deliver: false, deliveryNudgeStage: 'work' }).hits, 'R28'),
    ).toBeUndefined();
  });
});
