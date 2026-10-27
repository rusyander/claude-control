import { describe, expect, it } from 'vitest';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { acceptSplitGroup } from '../split-acceptance.ts';
import { SplitConveyor, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Принятая вручную группа без записанного MR (g2/g6 плана d9869abf, 19.10): хвост ответа
 * держал ссылку на MR, `mr` — нет, и после «Отметить готовой» хаб не показывал MR.
 * Конвейер и приёмка настоящие; снаружи — только фордж (ветка-источник MR).
 */

const PARENT = 'родитель';
const MR = 'https://git.example.com/group/app/-/merge_requests/1033';
const OTHER_MR = 'https://git.example.com/group/app/-/merge_requests/1050';

function record(): SplitPlanRecord {
  return {
    parentChatId: PARENT,
    projectPath: 'C:/repo',
    createdAt: '2026-10-16T15:15:52.605Z',
    request: {},
    proposal: { shared: '', groups: [] },
    groups: [
      {
        index: 0,
        title: 'Конструктор',
        branch: 'fix-PROJ-1689,PROJ-1688/builder-tools',
        after: [],
        status: 'paused',
        chatId: 'chat-0',
        tail: `MR: ${MR} — готово`,
      },
      {
        index: 1,
        title: 'Сосед',
        branch: 'fix-PROJ-1700/other',
        after: [],
        status: 'done',
        mr: OTHER_MR,
        tail: OTHER_MR,
      },
    ],
  } as unknown as SplitPlanRecord;
}

function build(branches: Record<string, string | undefined>) {
  const records = new Map<string, SplitPlanRecord>([[PARENT, record()]]);
  const asked: string[] = [];
  const store = {
    get: (parent: string) => structuredClone(records.get(parent)),
    set: (value: SplitPlanRecord) => void records.set(value.parentChatId, structuredClone(value)),
  };
  const deps = {
    store: {
      ...store,
      findByTriage: () => undefined,
      all: () => Object.fromEntries([...records].map(([k, v]) => [k, structuredClone(v)])),
    },
    launch: async () => ({ chats: [], failures: [] }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    resume: () => 'sent' as const,
    log: () => undefined,
    delivery: {
      facts: async () => ({ missing: [] }),
      nudge: () => 'sent' as const,
      branchOfMr: async (url: string) => {
        asked.push(url);
        return branches[url];
      },
    },
  } as unknown as SplitConveyorDeps;
  const conveyor = new SplitConveyor(deps);
  const group = (index: number) => records.get(PARENT)?.groups[index];
  const accept = (index: number) =>
    acceptSplitGroup(store, { parentChatId: PARENT, index, accepted: true });
  return { conveyor, group, accept, asked, records };
}

describe('принятая вручную группа получает MR из своего ответа', () => {
  it('фордж подтвердил ветку группы (её своя ветка с ключом задачи) — MR записан', async () => {
    const t = build({ [MR]: 'fix/PROJ-1689-builder' });
    t.accept(0);
    expect(t.group(0)?.mr).toBeUndefined();
    expect(await t.conveyor.linkAcceptedMr(PARENT, 0)).toBe(MR);
    expect(t.group(0)?.mr).toBe(MR);
    expect(t.group(0)?.markedDone?.from).toBe('paused');
  });

  it('ветка MR — чужая (другой ключ) или фордж молчит — MR не записан', async () => {
    const foreign = build({ [MR]: 'fix/PROJ-9999-else' });
    foreign.accept(0);
    expect(await foreign.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(foreign.group(0)?.mr).toBeUndefined();

    const silent = build({});
    silent.accept(0);
    expect(await silent.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(silent.group(0)?.mr).toBeUndefined();
  });

  it('ветка другой группы плана и MR, уже записанный соседу, не берутся', async () => {
    // Ветка соседа несёт тот же ключ задачи — ключ её своей не делает.
    const claimed = build({ [MR]: 'fix/PROJ-1689-followup' });
    const plan = claimed.records.get(PARENT) as SplitPlanRecord;
    (plan.groups[1] as { branch: string }).branch = 'fix/PROJ-1689-followup';
    claimed.accept(0);
    expect(await claimed.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(claimed.asked).toEqual([MR]);

    const taken = build({ [OTHER_MR]: 'fix/PROJ-1689-builder' });
    const value = taken.records.get(PARENT) as SplitPlanRecord;
    (value.groups[0] as { tail?: string }).tail = OTHER_MR;
    taken.accept(0);
    expect(await taken.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(taken.asked).toEqual([]);
  });

  it('записанный MR не трогается и форджа не спрашивает', async () => {
    const t = build({ [MR]: 'fix/PROJ-1689-builder' });
    const plan = t.records.get(PARENT) as SplitPlanRecord;
    const recorded = 'https://git.example.com/group/app/-/merge_requests/1001';
    (plan.groups[0] as { mr?: string }).mr = recorded;
    t.accept(0);
    expect(await t.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(t.asked).toEqual([]);
    expect(t.group(0)?.mr).toBe(recorded);
  });

  it('непринятая группа форджа не спрашивает; старт панели досвязывает принятые раньше', async () => {
    const t = build({ [MR]: 'fix-PROJ-1689,PROJ-1688/builder-tools' });
    expect(await t.conveyor.linkAcceptedMr(PARENT, 0)).toBeUndefined();
    expect(t.asked).toEqual([]);
    t.accept(0);
    t.conveyor.recoverAcceptedMrs();
    await new Promise((done) => setTimeout(done, 5));
    expect(t.group(0)?.mr).toBe(MR);
    expect(t.asked).toEqual([MR]);
  });
});
