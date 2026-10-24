import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * @covers apps/server/src/domains/chat/split-conveyor/split-conveyor.ts
 * @scenario Уборка копии (`cleanup`) ждёт `git worktree remove` секунды и минуты.
 * Запись, взятая ДО этого ожидания, не должна ложиться поверх той, что стала
 * правдой за время ожидания: новое «Разделить» у того же родителя или переезд
 * разделения к продолжению родителя. Хранилище настоящее (`AppStore` во
 * временном каталоге) — подменён только git снаружи (`remove`).
 */

const FIRST = {
  shared: '',
  groups: [{ title: 'Форма входа', branch: 'feature/login', tasks: ['поправить вход'] }],
};
const SECOND = {
  shared: '',
  groups: [{ title: 'Отчёты', branch: 'feature/reports', tasks: ['выгрузка отчёта'] }],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function triageDone(chatId: string): RunFinished {
  return {
    chatId,
    projectPath: 'C:/repo',
    text: 'Ничего не нашёл.',
    ok: true,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

async function closedGroup() {
  const appData = mkdtempSync(join(tmpdir(), 'conveyor-cleanup-'));
  dirs.push(appData);
  const store = new AppStore(appData);
  let triage = 0;
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => store.getSplitPlan(parent),
      set: (record) => store.setSplitPlan(record),
      findByTriage: (ids) => store.findSplitPlanByTriage(ids),
      all: () => store.getSplitPlans(),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `work-${record.proposal.groups[index]?.branch ?? index}`,
        path: `C:/copies/${record.proposal.groups[index]?.branch ?? index}`,
        isWorktree: true,
        started: true,
        prompt: '',
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: `triage-${++triage}`, started: true, deferred: false }),
    log: () => undefined,
  });
  await conveyor.begin({
    parentChatId: 'родитель',
    projectPath: 'C:/repo',
    proposal: FIRST,
    request: {},
  });
  conveyor.onTriageFinished(triageDone('triage-1'), ['triage-1']);
  await new Promise((done) => setTimeout(done, 40));
  const group = store.getSplitPlan('родитель')?.groups[0];
  if (!group?.path) throw new Error('группа не завелась');
  group.status = 'done';
  return { store, conveyor, path: group.path };
}

describe('SplitConveyor.cleanup: запись после долгого remove', () => {
  it('новое разделение, начатое пока копия убиралась, не стирается старой записью', async () => {
    const { store, conveyor, path } = await closedGroup();
    const cleaned = await conveyor.cleanup('родитель', 0, async () => {
      // Человек нажал «Разделить» снова, пока git убирал копию.
      await conveyor.begin({
        parentChatId: 'родитель',
        projectPath: 'C:/repo',
        proposal: SECOND,
        request: {},
      });
      return 'deleted';
    });
    const live = store.getSplitPlan('родитель');
    expect(live?.proposal.groups[0]?.title).toBe('Отчёты');
    // Отметка уборки — у бывшей группы, ушедшей в прошлое разделение.
    const retired = live?.retiredGroups?.find((group) => group.path === path);
    expect(retired?.cleaned).toEqual(cleaned);
    // И на диске то же: свежее хранилище читает тот же файл.
    const dir = dirs.at(-1) as string;
    expect(new AppStore(dir).getSplitPlan('родитель')?.proposal.groups[0]?.title).toBe('Отчёты');
  });

  it('разделение, переехавшее к продолжению родителя, получает отметку уборки и остаётся одно', async () => {
    const { store, conveyor, path } = await closedGroup();
    await conveyor.cleanup('родитель', 0, async () => {
      store.moveSplitPlan(['родитель'], 'продолжение');
      const moved = store.getSplitPlan('продолжение');
      // Запись после переезда меняет верхнее поле: старая копия записи его не знает.
      if (moved) store.setSplitPlan({ ...moved, order: [0], copyRoot: 'C:/repo-root' });
      return 'deleted';
    });
    const live = store.getSplitPlan('продолжение');
    expect(live?.copyRoot).toBe('C:/repo-root');
    expect(live?.groups.find((group) => group.path === path)?.cleaned?.branch).toBe('deleted');
  });

  it('копию делила группа прошлого разделения — отметку уборки получает и она', async () => {
    const { store, conveyor, path } = await closedGroup();
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: SECOND,
      request: {},
    });
    conveyor.onTriageFinished(triageDone('triage-2'), ['triage-2']);
    await new Promise((done) => setTimeout(done, 40));
    const record = store.getSplitPlan('родитель');
    const current = record?.groups[0];
    if (!record || !current) throw new Error('второе разделение не завелось');
    // Новая группа работает в той же копии, что и группа прошлого плана.
    current.path = path;
    current.status = 'done';
    store.setSplitPlan(record);
    expect(record.retiredGroups?.find((group) => group.path === path)?.cleaned).toBeUndefined();
    await conveyor.cleanup('родитель', 0, async () => 'deleted');
    const dir = dirs.at(-1) as string;
    const onDisk = new AppStore(dir).getSplitPlan('родитель');
    expect(onDisk?.groups[0]?.cleaned?.branch).toBe('deleted');
    expect(onDisk?.retiredGroups?.find((group) => group.path === path)?.cleaned?.branch).toBe(
      'deleted',
    );
  });

  it('разделение, которого не стало за время уборки (откат состояния), не воскресает', async () => {
    const { store, conveyor } = await closedGroup();
    await conveyor.cleanup('родитель', 0, async () => {
      // Откат к своему снимку, в котором разделения ещё не было.
      store.importState({});
      return 'deleted';
    });
    expect(store.getSplitPlan('родитель')).toBeUndefined();
  });
});
