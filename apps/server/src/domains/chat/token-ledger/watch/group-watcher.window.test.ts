import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupSignal } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { windowPointsOf, type LimitRunRecord } from '../../limit-journal/limit-journal.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Окно подписки на тике сторожа целиком (журнал лимита → оценка → запись группы): R9 —
 * уровень и прогноз окна аккаунта, R42 — тяжёлый прогон группы, отнесённый к ней по ключу
 * чата или сессии через связи дерева. Подменены только часы и ответ журнала лимита.
 */

const T = (hms: string): number => Date.parse(`2026-10-26T${hms}Z`);
const fixture = (name: string): LimitRunRecord[] =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8'),
  ) as LimitRunRecord[];

function setup(journal: LimitRunRecord[]) {
  let now = T('10:45:00');
  const group = {
    index: 3,
    title: 'g3',
    status: 'started',
    chatId: 'child-3',
    path: 'C:\\work\\app',
  } as SplitPlanGroupRecord;
  const notified: GroupSignal[] = [];
  let id = 0;
  // Связи дерева: звено группы и его новый разговор под временным ключом; прочее — одиночный чат.
  const linked = new Set(['child-3', 's3', 's3-next']);
  const watcher = new GroupWatcher({
    settings: () => GROUP_WATCH_DEFAULTS,
    resolve: (chatId, sessionId) => {
      const key = [chatId, sessionId].find((one) => one && linked.has(one));
      if (key) return { chatId: key, parentChatId: 'parent', groupIndex: 3 };
      return { scope: 'chat', chatId, parentChatId: chatId, groupIndex: -1 };
    },
    group: (parent, index) => (parent === 'parent' && index === 3 ? group : undefined),
    save: () => {},
    node: () => ({ running: true, paused: false }),
    notify: (signal) => notified.push(signal),
    now: () => now,
    makeId: () => `id${++id}`,
    plans: () => ({ parent: { groups: [group] } }),
    limitRuns: () => journal,
    limitSamples: () => windowPointsOf(journal),
  });
  watcher.onFeed('child-3', { kind: 'start', sessionId: 's3', cwd: 'C:\\work\\app' });
  return {
    watcher,
    notified,
    at: (t: number) => {
      now = t;
    },
    active: (rule: string) =>
      (group.watch?.signals ?? []).filter((s) => s.rule === rule && !s.clearedAt),
  };
}

describe('GroupWatcher R42 тяжёлый прогон группы', () => {
  it('прогон звена и прогон под ключом new-… — сведение на записи группы по последнему, без Telegram', () => {
    const w = setup(fixture('R42-heavy-run/fire.json'));
    w.watcher.tick();
    expect(w.active('R42')).toMatchObject([
      {
        severity: 'info',
        numbers: { runs: 2, mTokens: 3.4, runMin: 19, fivePct: 2, weekPct: 0 },
        textKey: 'groupWatch.rule.R42',
      },
    ]);
    expect(w.notified.filter((s) => s.rule === 'R42')).toEqual([]);
    // Через полчаса после конца последнего прогона сигнал закрыт.
    w.at(T('11:10:01'));
    w.watcher.tick();
    expect(w.active('R42')).toEqual([]);
  });

  it('близкий промах: опора из сброшенного окна, шаг под порогами, открытая запись, тяжёлый одиночный чат — тишина', () => {
    const w = setup(fixture('R42-heavy-run/near-miss.json'));
    w.watcher.tick();
    expect(w.active('R42')).toEqual([]);
  });
});

describe('GroupWatcher R9 уровни окна аккаунта', () => {
  it('недельное окно на 91 % — сведение на записи группы, без Telegram', () => {
    const w = setup(fixture('R9-window/fire.json'));
    w.watcher.tick();
    expect(w.active('R9')).toMatchObject([
      {
        severity: 'info',
        numbers: { nowPct: 91, levelPct: 90 },
        textKey: 'groupWatch.rule.R9levelWeek',
      },
    ]);
    expect(w.notified).toEqual([]);
  });

  it('живой замер потока: недельное окно остаётся недельным (уровень 90 недели, а не пятичасового)', () => {
    const w = setup([]);
    const sample = {
      at: T('10:44:00'),
      fiveHour: { utilization: 0.4, resetsAt: T('15:00:00') / 1000 },
      sevenDay: { utilization: 0.92, resetsAt: Date.parse('2026-10-30T08:00:00Z') / 1000 },
    };
    w.watcher.onFeed('child-3', {
      kind: 'event',
      sessionId: 's3',
      event: {
        kind: 'limit',
        resetsAt: sample.fiveHour.resetsAt,
        type: 'five_hour',
        status: 'allowed',
        sample,
      },
    });
    w.watcher.tick();
    expect(w.active('R9')).toMatchObject([
      { numbers: { nowPct: 92, levelPct: 90 }, textKey: 'groupWatch.rule.R9levelWeek' },
    ]);
  });

  it('близкий промах: замер сброшенного окна и 79 % — тишина', () => {
    const w = setup(fixture('R9-window/near-miss.json'));
    w.watcher.tick();
    expect(w.active('R9')).toEqual([]);
  });
});
