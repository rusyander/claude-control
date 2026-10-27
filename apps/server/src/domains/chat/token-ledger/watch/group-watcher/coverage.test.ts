import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  groupWatchCoverageOf,
  groupWatchCoverageSummaryOf,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import type { LimitRunRecord } from '../../../limit-journal/limit-journal.ts';
import { coverageOf, coverageSummary, providerOfParent, type PanelSources } from './coverage.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Охват сторожа: чем видна группа (поток, транскрипт, только текст, никак) и каких
 * источников нет. Чистая часть — по входу; через сторожа — по сессиям, что он ведёт.
 */

const FULL: PanelSources = { ledger: true, devWatch: true, limitJournal: true };

describe('coverageOf охват группы', () => {
  it('Claude без сессии — поток, все источники на месте — пробелов нет', () => {
    expect(coverageOf({ enabled: true, provider: 'claude', sessions: [], panel: FULL })).toEqual({
      by: 'stream',
      gaps: [],
    });
  });

  it('прогон Claude подхвачен без потока — транскрипт; поток второй сессии важнее', () => {
    const detached = { detached: true };
    expect(
      coverageOf({ enabled: true, provider: 'claude', sessions: [detached], panel: FULL }).by,
    ).toBe('transcript');
    expect(
      coverageOf({ enabled: true, provider: 'claude', sessions: [detached, {}], panel: FULL }).by,
    ).toBe('stream');
  });

  it('Codex, Qwen, Continue и OpenCode — транскрипт, Gemini — поток хода, aider — только текст и пробел переписки', () => {
    // OpenCode — база SQLite CLI: драйвер `node:sqlite` у Node проекта есть.
    for (const provider of ['codex', 'qwen', 'continue', 'opencode']) {
      expect(coverageOf({ enabled: true, provider, sessions: [], panel: FULL })).toEqual({
        by: 'transcript',
        gaps: [],
      });
      expect(
        coverageOf({ enabled: true, provider, sessions: [{ provider }], panel: FULL }).by,
      ).toBe('transcript');
    }
    // Gemini CLI: файла переписки у хода `-p` нет, сторож читает строки его потока.
    for (const sessions of [[], [{ provider: 'gemini' }]]) {
      expect(coverageOf({ enabled: true, provider: 'gemini', sessions, panel: FULL })).toEqual({
        by: 'stream',
        gaps: [],
      });
    }
    expect(
      coverageOf({
        enabled: true,
        provider: 'aider',
        sessions: [{ provider: 'aider' }],
        panel: FULL,
      }),
    ).toEqual({ by: 'text-only', gaps: ['transcript'] });
  });

  it('сторож выключен — никак, без пробелов', () => {
    expect(
      coverageOf({
        enabled: false,
        provider: 'claude',
        sessions: [{}],
        panel: { ledger: false, devWatch: false, limitJournal: false },
      }),
    ).toEqual({ by: 'blind', gaps: [] });
  });

  it('пробелы панели: журнал проверок, dev-watch; журнал лимита — только у Claude', () => {
    const panel = { ledger: false, devWatch: false, limitJournal: false };
    expect(coverageOf({ enabled: true, provider: 'claude', sessions: [], panel }).gaps).toEqual([
      'ledger',
      'devWatch',
      'limitJournal',
    ]);
    expect(coverageOf({ enabled: true, provider: 'codex', sessions: [], panel }).gaps).toEqual([
      'ledger',
      'devWatch',
    ]);
  });

  it('провайдер — по ключу родителя: именованный ключ чужого CLI, голый — Claude', () => {
    expect(providerOfParent('qwen:abc')).toBe('qwen');
    expect(providerOfParent('3f2a-uuid')).toBe('claude');
  });
});

describe('coverageSummary строка настроек', () => {
  it('счёт по источникам и объединение пробелов групп', () => {
    const summary = coverageSummary(
      [
        { by: 'stream', gaps: [] },
        { by: 'stream', gaps: [] },
        { by: 'text-only', gaps: ['transcript'] },
      ],
      FULL,
      true,
    );
    expect(summary).toEqual({
      groups: { stream: 2, transcript: 0, 'text-only': 1, blind: 0 },
      gaps: ['transcript'],
    });
  });

  it('пробелы панели видны и без живых групп; выключенный сторож их не называет', () => {
    const panel = { ledger: false, devWatch: false, limitJournal: false };
    expect(coverageSummary([], panel, true).gaps).toEqual(['ledger', 'devWatch']);
    expect(coverageSummary([], panel, false).gaps).toEqual([]);
  });
});

describe('разбор охвата на входе клиента', () => {
  it('неизвестный источник — охвата нет; неизвестный и повторный пробел отброшены', () => {
    expect(groupWatchCoverageOf({ by: 'telepathy', gaps: [] })).toBeUndefined();
    expect(groupWatchCoverageOf(null)).toBeUndefined();
    expect(
      groupWatchCoverageOf({ by: 'text-only', gaps: ['transcript', 'future', 'transcript'] }),
    ).toEqual({ by: 'text-only', gaps: ['transcript'] });
  });

  it('сводка: битые счёты — ноль, источники все, пробелы только известные', () => {
    expect(
      groupWatchCoverageSummaryOf({
        groups: { stream: 2, blind: -1, transcript: 'x' },
        gaps: ['ledger', 7],
      }),
    ).toEqual({ groups: { stream: 2, transcript: 0, 'text-only': 0, blind: 0 }, gaps: ['ledger'] });
    expect(groupWatchCoverageSummaryOf(undefined)).toEqual({
      groups: { stream: 0, transcript: 0, 'text-only': 0, blind: 0 },
      gaps: [],
    });
  });
});

function setup(opts: { parent: string; runs?: LimitRunRecord[]; status?: string }) {
  const group = {
    index: 1,
    title: 'g1',
    status: opts.status ?? 'started',
    chatId: 'child-1',
    path: 'C:\\work\\app',
  } as SplitPlanGroupRecord;
  const idle = { index: 2, title: 'g2', status: 'done', chatId: 'child-2' } as SplitPlanGroupRecord;
  const other = {
    index: 3,
    title: 'g3',
    status: 'started',
    chatId: 'child-3',
  } as SplitPlanGroupRecord;
  const groups = [group, idle, other];
  const watcher = new GroupWatcher({
    settings: () => GROUP_WATCH_DEFAULTS,
    resolve: (chatId) => {
      const index = groups.find((one) => one.chatId === chatId && one.index !== 2)?.index;
      return index ? { chatId, parentChatId: opts.parent, groupIndex: index } : undefined;
    },
    group: (parent, index) =>
      parent === opts.parent ? groups.find((one) => one.index === index) : undefined,
    save: () => {},
    node: () => ({ running: true, paused: false }),
    plans: () => ({ [opts.parent]: { groups } }),
    panelSources: () => ({ ledger: true, devWatch: false }),
    limitRuns: () => opts.runs ?? [],
    now: () => Date.parse('2026-10-27T10:00:00Z'),
  });
  return watcher;
}

describe('GroupWatcher.coverageOf по сессиям сторожа', () => {
  it('звено Claude подхвачено без потока — транскрипт; пробелы dev-watch и пустого журнала лимита', () => {
    const watcher = setup({ parent: 'parent' });
    watcher.onFeed('child-1', {
      kind: 'start',
      sessionId: 's1',
      cwd: 'C:\\work\\app',
      detached: true,
    });
    // Живой поток соседней группы того же плана охват этой не поднимает.
    watcher.onFeed('child-3', { kind: 'start', sessionId: 's3', cwd: 'C:\\work\\app3' });
    expect(watcher.coverageOf('parent', 1)).toEqual({
      by: 'transcript',
      gaps: ['devWatch', 'limitJournal'],
    });
    expect(watcher.coverageOf('parent', 3)?.by).toBe('stream');
  });

  it('кончившаяся и неизвестная группа — охвата нет; сводка считает только живые', () => {
    const run = { id: 'r', chatId: 'x', startedAt: 1, endedAt: 2, tokens: 1, samples: [] };
    const watcher = setup({ parent: 'aider:p1', runs: [run] });
    expect(watcher.coverageOf('aider:p1', 2)).toBeUndefined();
    expect(watcher.coverageOf('aider:p1', 9)).toBeUndefined();
    expect(watcher.coverageOf('aider:p1', 1)).toEqual({
      by: 'text-only',
      gaps: ['devWatch', 'transcript'],
    });
    expect(watcher.coverageSummary()).toEqual({
      groups: { stream: 0, transcript: 0, 'text-only': 2, blind: 0 },
      gaps: ['devWatch', 'transcript'],
    });
  });

  it('группа Gemini CLI — поток хода, пробела переписки нет', () => {
    const watcher = setup({ parent: 'gemini:p1' });
    expect(watcher.coverageOf('gemini:p1', 1)).toEqual({ by: 'stream', gaps: ['devWatch'] });
  });
});
