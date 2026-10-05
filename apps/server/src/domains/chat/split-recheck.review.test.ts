import { describe, it, expect } from 'vitest';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import type { MrReview } from '../integrations/mr-review.ts';
import { SplitConveyor } from './split-conveyor.ts';
import { MrWatch } from './mr-watch.ts';
import { recheckDeliveredMr } from './split-recheck.ts';

/**
 * Ревью «Продолжить» / «Перепроверить MR» (05.10.2026): сценарии R1–R5 и G1,
 * на которых прежний код красил строку зелёной без перепроверки, вешал
 * «Перепроверяется…» навсегда, возвращал убранную группу и дважды слал тот же
 * красный конвейер. Заглушка `resume` зовёт `onChainResumed` сразу — как
 * слушатель старта прогона в рантайме.
 */

const MR = 'https://tracker.example.com/team/app/-/merge_requests/810';
const NOW = '2026-10-05T11:20:00.000Z';
const RECHECK = 'recheck its delivered MR';

function record(groups: Partial<SplitPlanGroupRecord>[]): SplitPlanRecord {
  return {
    parentChatId: 'parent',
    projectPath: 'C:/repo',
    createdAt: '2026-10-05T09:00:00.000Z',
    order: groups.map((_, index) => index),
    request: {},
    proposal: {
      groups: groups.map((_, index) => ({
        title: `G${index}`,
        branch: `feature/g${index}`,
        tasks: [`PROJ-${100 + index}`],
      })),
    },
    groups: groups.map((group, index) => ({
      index,
      title: `G${index}`,
      branch: `feature/g${index}`,
      after: [],
      status: 'done',
      deliver: true,
      chatId: `chat-${index}`,
      path: `C:/wt/g${index}`,
      startedAt: '2026-10-05T09:05:00.000Z',
      ...group,
    })),
  } as SplitPlanRecord;
}

function build(initial: SplitPlanRecord, review?: MrReview, parallel?: number) {
  const records = new Map<string, SplitPlanRecord>();
  records.set('parent', structuredClone(initial));
  const store = {
    get: (p: string) => {
      const found = records.get(p);
      return found ? structuredClone(found) : undefined;
    },
    set: (next: SplitPlanRecord) => void records.set(next.parentChatId, structuredClone(next)),
    all: () => Object.fromEntries(records),
    findByTriage: () => undefined,
  };
  const state = { resume: 'sent' as 'sent' | 'queued' | 'refused', reads: 0 };
  const resumed: { index: number; prompt: string }[] = [];
  const link = (index = 0): ChatLink => ({
    parentChatId: 'parent',
    createdAt: '',
    branch: `feature/g${index}`,
    groupIndex: index,
    stage: 'work',
  });
  const holder: { conveyor?: SplitConveyor } = {};
  const conveyor = new SplitConveyor({
    store,
    launch: async () => ({ chats: [], failures: [] }),
    startTriage: () => ({ chatId: 'triage', started: false, deferred: false }),
    resume: (group, prompt) => {
      const outcome = state.resume;
      if (outcome !== 'refused') resumed.push({ index: group.index, prompt });
      if (outcome === 'sent') holder.conveyor?.onChainResumed(link(group.index));
      return outcome;
    },
    ...(parallel ? { parallel: () => parallel } : {}),
    delivery: {
      facts: async () => ({ missing: [], mr: MR }),
      nudge: () => 'refused',
      schedule: (run) => void run(),
    },
    log: () => undefined,
    now: () => new Date(NOW),
  });
  holder.conveyor = conveyor;
  const recheck = () =>
    recheckDeliveredMr(
      {
        store,
        read: async () => {
          state.reads += 1;
          return review;
        },
        recheck: (p, i, prompt) => conveyor.recheckDelivered(p, i, prompt),
        log: () => undefined,
      },
      'parent',
      0,
    );
  const group = (index = 0): SplitPlanGroupRecord => {
    const found = records.get('parent')?.groups[index];
    if (!found) throw new Error(`no group ${index}`);
    return found;
  };
  const flush = () => new Promise((done) => setTimeout(done, 5));
  return { conveyor, recheck, resumed, group, link, flush, state, store };
}

/** Группа 0 доставлена, группа 1 работает и держит единственное место. */
const busyCeiling = () =>
  record([
    { mr: MR, doneAt: '2026-10-05T10:00:00.000Z' },
    { status: 'started', deliver: false },
  ]);

describe('перепроверка MR — отметку ставит только её ход (R1)', () => {
  it('чужой ход, кончившийся доставкой, пока перепроверка ждёт места, зелёным не красит', async () => {
    const t = build(busyCeiling(), { state: 'open', threads: [] }, 1);
    expect((await t.recheck()).outcome).toBe('queued');
    // Человек пишет в чат доставленной группы — её ход, но не перепроверка.
    t.conveyor.onChainResumed(t.link(0));
    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    expect(t.group().recheckedAt).toBeUndefined();
    expect(t.group().recheckRequestedAt).toBe(NOW);
    expect(t.group().parked?.recheck).toBe(true);

    // Место освободилось — перепроверка ушла, её ход кончился доставкой.
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.resumed.at(-1)?.prompt).toContain(RECHECK);
    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    expect(t.group().recheckedAt).toBe(NOW);
    expect(t.group().recheckRequestedAt).toBeUndefined();
  });

  it('второе нажатие, пока перепроверка ждёт, второго слова не кладёт (G1)', async () => {
    const t = build(busyCeiling(), { state: 'open', threads: [] }, 1);
    await t.recheck();
    expect((await t.recheck()).outcome).toBe('queued');
    const parked = t.group().parked?.prompt ?? '';
    expect(parked.split(RECHECK).length - 1).toBe(1);
  });
});

describe('перепроверка MR — «Перепроверяется…» не застревает (R2)', () => {
  it('отложенное слово отклонено при отдаче — отметка снята, прежняя зелёная на месте', async () => {
    const t = build(
      record([
        { mr: MR, doneAt: '2026-10-05T10:00:00.000Z', recheckedAt: '2026-10-05T08:00:00.000Z' },
        { status: 'started', deliver: false },
      ]),
      { state: 'open', threads: [] },
      1,
    );
    expect((await t.recheck()).outcome).toBe('queued');
    t.state.resume = 'refused';
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.group().parked).toBeUndefined();
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.group().recheckSentAt).toBeUndefined();
    expect(t.group().recheckedAt).toBe('2026-10-05T08:00:00.000Z');
  });

  it('слово в очереди сессии умерло с перезапуском панели — отметка снимается при старте', () => {
    const t = build(
      record([{ mr: MR, recheckRequestedAt: NOW, recheckSentAt: NOW, status: 'done' }]),
    );
    t.conveyor.recoverDeliveryChecks();
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.group().recheckSentAt).toBeUndefined();
  });

  it('идущий ход перепроверки перезапуск не снимает', () => {
    const t = build(
      record([{ mr: MR, recheckRequestedAt: NOW, recheckSentAt: NOW, recheckRunning: true }]),
    );
    t.conveyor.recoverDeliveryChecks();
    expect(t.group().recheckRequestedAt).toBe(NOW);
  });
});

describe('«Убрать» — без возврата (R3)', () => {
  it('убранной группе «Продолжить» отказано, она не стартует', () => {
    const t = build(record([{ status: 'paused', pausedAt: NOW }]));
    t.conveyor.dropGroup('parent', 0);
    expect(t.group().droppedAt).toBe(NOW);
    expect(() => t.conveyor.continueGroup('parent', 0)).toThrow();
    expect(t.group().status).toBe('failed');
    expect(t.resumed).toHaveLength(0);
    expect(t.conveyor.view(['parent'])?.groups[0]?.droppedAt).toBe(NOW);
  });
});

describe('«Продолжить» в очередь занятой сессии (G2)', () => {
  const failed = () => record([{ status: 'failed', error: 'Not logged in' }]);

  it('второе нажатие второго задания не кладёт; начало хода отметку снимает', () => {
    const t = build(failed());
    t.state.resume = 'queued';
    expect(t.conveyor.continueGroup('parent', 0)).toBe('queued');
    expect(t.group().continueQueuedAt).toBe(NOW);
    expect(t.conveyor.continueGroup('parent', 0)).toBe('queued');
    expect(t.resumed).toHaveLength(1);
    t.conveyor.onChainResumed(t.link(0));
    expect(t.group().continueQueuedAt).toBeUndefined();
  });

  it('очередь умерла с перезапуском панели — кнопка снова кладёт задание', () => {
    const t = build(failed());
    t.state.resume = 'queued';
    t.conveyor.continueGroup('parent', 0);
    t.conveyor.recoverDeliveryChecks();
    expect(t.group().continueQueuedAt).toBeUndefined();
    t.conveyor.continueGroup('parent', 0);
    expect(t.resumed).toHaveLength(2);
  });
});

describe('ревью по ссылке (Q1)', () => {
  it('вид плана несёт флаг — строка не предлагает перепроверку, которой сервер откажет', async () => {
    const initial = record([{ mr: MR }]);
    (initial.proposal.groups[0] as { review?: unknown }).review = { url: MR };
    const t = build(initial, { state: 'open', threads: [] });
    expect(t.conveyor.view(['parent'])?.groups[0]?.review).toBe(true);
    await expect(t.recheck()).rejects.toThrow();
  });
});

describe('влитой MR (R4)', () => {
  it('состояние ложится в запись, и второе нажатие отказывает без чтения форджа', async () => {
    const t = build(record([{ mr: MR }]), { state: 'merged', threads: [] });
    await expect(t.recheck()).rejects.toThrow(/влит/);
    expect(t.group().mrClosed).toBe('merged');
    expect(t.conveyor.view(['parent'])?.groups[0]?.mrClosed).toBe('merged');
    await expect(t.recheck()).rejects.toThrow();
    expect(t.state.reads).toBe(1);
    expect(t.resumed).toHaveLength(0);
  });

  it('закрытый, а потом открытый снова MR — пометка снимается чтением', async () => {
    const t = build(record([{ mr: MR, mrClosed: 'closed' }]), { state: 'open', threads: [] });
    await t.recheck();
    expect(t.group().mrClosed).toBeUndefined();
  });
});

describe('красный конвейер перепроверки (R5)', () => {
  it('записан наблюдателю: тот же конвейер второй раз не уходит', async () => {
    const review: MrReview = {
      state: 'open',
      threads: [],
      pipeline: { id: '7763', status: 'failed', url: 'https://tracker.example.com/p/7763' },
    };
    const t = build(
      record([
        {
          mr: MR,
          doneAt: '2026-10-05T10:00:00.000Z',
          mrWatch: { cycle: '2026-10-05T10:00:00.000Z', checks: 1 },
        },
      ]),
      review,
    );
    await t.recheck();
    expect(t.resumed[0]?.prompt).toContain('#7763');
    expect(t.group().mrWatch?.pipeline).toEqual({ id: '7763', status: 'failed' });
    t.conveyor.onChainEnded(t.link(), { status: 'done' });
    await t.flush();
    const watchResumed: string[] = [];
    const watch = new MrWatch({
      store: t.store,
      read: async () => review,
      resume: (p, i, prompt) => {
        watchResumed.push(prompt);
        return t.conveyor.resumeDelivered(p, i, prompt);
      },
      schedule: () => undefined,
      log: () => undefined,
      now: () => new Date(NOW),
    });
    watch.sync('parent');
    await watch.check('parent', 0, t.group().doneAt ?? '');
    expect(watchResumed).toHaveLength(0);
  });
});
