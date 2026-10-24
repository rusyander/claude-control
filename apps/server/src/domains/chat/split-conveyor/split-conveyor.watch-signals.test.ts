import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GroupSignal, GroupWatchRecord } from '@agentdeck/contracts/group-watch';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * @covers apps/server/src/domains/chat/split-conveyor/split-conveyor.ts
 * @scenario Сторож групп пишет сигналы в свой срез хранилища, конвейер — запись
 * разделения. F-42: запись конвейера после долгого `await` не стирает сигналы,
 * записанные за это время, а вид группы их показывает; F-64: битый блок с диска
 * не роняет вид. Хранилище — настоящее `AppStore` во временном каталоге.
 */

const PROPOSAL = {
  shared: '',
  groups: [{ title: 'Форма входа', branch: 'feature/login', tasks: ['поправить вход'] }],
};

const SIGNAL: GroupSignal = {
  id: 'sig-1',
  rule: 'R1',
  severity: 'alert',
  groupIndex: 0,
  chatId: 'work-1',
  at: '2026-10-22T10:00:00.000Z',
  numbers: { idleMin: 21 },
  textKey: 'groupWatch.rule.R1',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function triageDone(): RunFinished {
  return {
    chatId: 'triage',
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

function build(duringLaunch: (store: AppStore) => void = () => undefined) {
  const appData = mkdtempSync(join(tmpdir(), 'conveyor-watch-'));
  dirs.push(appData);
  const store = new AppStore(appData);
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => store.getSplitPlan(parent),
      set: (record) => store.setSplitPlan(record),
      findByTriage: (ids) => store.findSplitPlanByTriage(ids),
      all: () => store.getSplitPlans(),
      watchSignals: (parent, index) => store.getGroupWatchSignals(parent, index),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => {
      // Копии заводятся минутами: за это время сторож успевает записать сигнал.
      await new Promise((done) => setTimeout(done, 5));
      duringLaunch(store);
      return {
        chats: groups.map((index) => ({
          index,
          title: record.proposal.groups[index]?.title ?? '',
          branch: record.groups[index]?.branch ?? '',
          chatId: 'work-1',
          path: 'C:/copies/0',
          isWorktree: true,
          started: true,
          prompt: '',
        })),
        failures: [],
      };
    },
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    log: () => undefined,
  });
  const start = async () => {
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    conveyor.onTriageFinished(triageDone(), ['triage']);
    await new Promise((done) => setTimeout(done, 40));
  };
  return { store, conveyor, start, appData };
}

describe('SplitConveyor и сигналы сторожа', () => {
  it('запись итога запуска после await сохраняет сигнал, записанный сторожем за это время', async () => {
    const { conveyor, start, appData } = build((store) => {
      // Сторож пишет так же, как проводка: свой срез, затем на диск.
      store.putGroupWatchSignals('родитель', 0, { signals: [SIGNAL] });
      store.saveGroupWatchSignals();
    });
    await start();
    expect(conveyor.view(['родитель'])?.groups[0]?.status).toBe('started');
    expect(conveyor.view(['родитель'])?.groups[0]?.watchSignals).toEqual([SIGNAL]);
    // И на диске: свежее хранилище читает тот же файл.
    const reread = new AppStore(appData);
    expect(reread.getGroupWatchSignals('родитель', 0)?.signals).toEqual([SIGNAL]);
    expect(reread.getSplitPlan('родитель')?.groups[0]?.chatId).toBe('work-1');
    expect(reread.getSplitPlan('родитель')?.groups[0]?.watch).toBeUndefined();
  });

  it('битый блок watch с диска не роняет вид: целые сигналы видны, битые пропущены', async () => {
    const { store, conveyor, start } = build();
    await start();
    const put = (block: unknown): void =>
      store.putGroupWatchSignals('родитель', 0, block as GroupWatchRecord);
    put({});
    expect(() => conveyor.view(['родитель'])).not.toThrow();
    expect(conveyor.view(['родитель'])?.groups[0]?.watchSignals).toBeUndefined();
    put({ signals: 'нет' });
    expect(conveyor.view(['родитель'])?.groups[0]?.watchSignals).toBeUndefined();
    put({ signals: [null, { rule: 'R1' }, { ...SIGNAL, rule: 'R99' }, SIGNAL] });
    expect(conveyor.view(['родитель'])?.groups[0]?.watchSignals).toEqual([SIGNAL]);
  });
});
