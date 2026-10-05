import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { SplitConveyor, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Действия человека посреди разбора разделения (ревью PR #1): блок разбора
 * раскладывает очередь, но не отменяет паузу, «Убрать» и не запускает группу второй раз.
 */

const PARENT = 'p';
const GROUPS = [
  { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 a'] },
  { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 b'] },
];
const block = (json: unknown) =>
  ['ok', '```' + SPLIT_PLAN_BLOCK_LANG, JSON.stringify(json), '```'].join('\n');

function build() {
  const records = new Map<string, SplitPlanRecord>();
  const launches: number[][] = [];
  const deps: SplitConveyorDeps = {
    store: {
      get: (k) => (records.has(k) ? structuredClone(records.get(k)!) : undefined),
      set: (r) => void records.set(r.parentChatId, structuredClone(r)),
      findByTriage: (ids) => {
        const r = [...records.values()].find((x) => ids.includes(x.triageChatId ?? ''));
        return r ? structuredClone(r) : undefined;
      },
      all: () => Object.fromEntries([...records].map(([k, v]) => [k, structuredClone(v)])),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => {
      launches.push(groups);
      return {
        chats: groups.map((index) => ({
          index,
          title: '',
          branch: record.groups[index]?.branch ?? '',
          chatId: `chat-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: true,
          prompt: '',
        })),
        failures: [],
      };
    },
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    parallel: () => 2,
    log: () => undefined,
    now: () => new Date(Date.UTC(2026, 8, 30, 9)),
  };
  const conveyor = new SplitConveyor(deps);
  const flush = () => new Promise((d) => setTimeout(d, 5));
  const begin = async () => {
    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: 'C:/repo',
      proposal: { groups: GROUPS },
      request: {},
    });
    await flush();
  };
  const finishTriage = async () => {
    conveyor.onTriageFinished(
      { ok: true, text: block({ groups: [{ index: 1 }, { index: 2 }], order: [1, 2] }) },
      ['triage'],
    );
    await flush();
  };
  return {
    conveyor,
    records,
    launches,
    begin,
    finishTriage,
    group: (i: number) => records.get(PARENT)?.groups[i],
  };
}

describe('разделение: человек посреди разбора', () => {
  it('пауза посреди разбора переживает его блок', async () => {
    const t = build();
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    expect(t.group(0)?.status).toBe('paused');
    await t.finishTriage();
    expect(t.group(0)?.status).toBe('paused');
  });

  it('«Убрать» посреди разбора — группа так и остаётся убранной', async () => {
    const t = build();
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    t.conveyor.dropGroup(PARENT, 0);
    expect(t.group(0)?.status).toBe('failed');
    await t.finishTriage();
    expect(t.group(0)?.status).toBe('failed');
  });

  it('«Запустить сейчас» посреди разбора — отказ; группу заводит блок разбора, один раз', async () => {
    const t = build();
    await t.begin();
    await expect(t.conveyor.startNow(PARENT, 0)).rejects.toMatchObject({
      messageCode: 'split-start-triage',
    });
    await t.finishTriage();
    expect(t.launches.flat().filter((i) => i === 0)).toHaveLength(1);
  });
});
