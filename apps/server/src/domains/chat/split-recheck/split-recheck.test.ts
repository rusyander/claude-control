import { describe, it, expect } from 'vitest';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import { SplitConveyor, type DeliveryVerdict } from '../split-conveyor/split-conveyor.ts';
import { recheckDeliveredMr } from './split-recheck.ts';

/**
 * «Продолжить» недоделанной группы и «Перепроверить MR» доставленной
 * (владелец 05.10.2026). Конвейер настоящий; снаружи — фордж (`read`),
 * продолжение сессии (`resume`), факты git доставки и часы.
 */

const MR = 'https://git.acme.local/team/app/-/merge_requests/810';
const NOW = '2026-10-05T11:20:00.000Z';
const REVIEWER = 'simonenko';
const AUTHOR = 'rustam';

function thread(id: string, author: string, body: string, noteId: string): MrReviewThread {
  return {
    id,
    resolvable: true,
    resolved: false,
    notes: [{ id: noteId, author, body }],
    path: 'src/ui/Menu.tsx',
    line: 42,
  };
}

function record(
  groups: Partial<SplitPlanGroupRecord>[],
  extra: Partial<SplitPlanRecord> = {},
): SplitPlanRecord {
  return {
    parentChatId: 'parent',
    projectPath: 'C:/repo',
    createdAt: '2026-10-05T09:00:00.000Z',
    order: groups.map((_, index) => index),
    request: {},
    proposal: {
      groups: groups.map((_, index) => ({
        title: `Группа ${index}`,
        branch: `feature/g${index}`,
        tasks: [`PROJ-${100 + index} задача`],
      })),
    },
    groups: groups.map((group, index) => ({
      index,
      title: `Группа ${index}`,
      branch: `feature/g${index}`,
      after: [],
      status: 'done',
      deliver: true,
      chatId: `chat-${index}`,
      path: `C:/wt/g${index}`,
      startedAt: '2026-10-05T09:05:00.000Z',
      ...group,
    })),
    ...extra,
  };
}

function build(
  options: {
    record?: SplitPlanRecord;
    review?: MrReview | Error;
    resume?: 'sent' | 'queued' | 'refused';
    parallel?: number;
    verdict?: DeliveryVerdict;
  } = {},
) {
  const records = new Map<string, SplitPlanRecord>();
  const initial =
    options.record ?? record([{ mr: MR, doneAt: '2026-10-05T10:00:00.000Z', recheckedAt: 'old' }]);
  records.set(initial.parentChatId, structuredClone(initial));
  const store = {
    get: (parent: string) => {
      const found = records.get(parent);
      return found ? structuredClone(found) : undefined;
    },
    set: (next: SplitPlanRecord) => void records.set(next.parentChatId, structuredClone(next)),
    all: () => Object.fromEntries(records),
    findByTriage: () => undefined,
  };
  const resumed: { index: number; prompt: string }[] = [];
  const conveyor = new SplitConveyor({
    store,
    launch: async () => ({ chats: [], failures: [] }),
    startTriage: () => ({ chatId: 'triage', started: false, deferred: false }),
    resume: (group, prompt) => {
      const outcome = options.resume ?? 'sent';
      if (outcome !== 'refused') resumed.push({ index: group.index, prompt });
      return outcome;
    },
    ...(options.parallel ? { parallel: () => options.parallel as number } : {}),
    delivery: {
      facts: async () => options.verdict ?? { missing: [], mr: MR },
      nudge: () => 'refused',
      schedule: (run) => void run(),
    },
    log: () => undefined,
    now: () => new Date(NOW),
  });
  const reads: string[] = [];
  const recheck = () =>
    recheckDeliveredMr(
      {
        store,
        read: async (url) => {
          reads.push(url);
          if (options.review instanceof Error) throw options.review;
          return options.review;
        },
        recheck: (parent, index, prompt) => conveyor.recheckDelivered(parent, index, prompt),
        log: () => undefined,
      },
      'parent',
      0,
    );
  const group = (index = 0) => records.get('parent')!.groups[index]!;
  const link = (index = 0): ChatLink => ({
    parentChatId: 'parent',
    createdAt: '',
    branch: `feature/g${index}`,
    groupIndex: index,
    stage: 'work',
  });
  const flush = () => new Promise((done) => setTimeout(done, 5));
  return { conveyor, recheck, resumed, reads, group, link, flush, records };
}

const codeOf = (error: unknown) => (error as { messageCode?: string }).messageCode;

describe('«Перепроверить MR» доставленной группы', () => {
  it('задание: конфликты по форджу, ВСЕ ждущие ветки (и переданные), красный конвейер, готовность задач', async () => {
    const t = build({
      record: record([
        {
          mr: MR,
          doneAt: '2026-10-05T10:00:00.000Z',
          recheckedAt: '2026-10-04T08:00:00.000Z',
          // Ветку d1 наблюдатель уже передавал — перепроверка смотрит и её.
          mrWatch: { cycle: '2026-10-05T10:00:00.000Z', checks: 2, relayed: ['d1:17928'] },
        },
      ]),
      review: {
        state: 'open',
        author: AUTHOR,
        conflicts: true,
        threads: [
          thread('d1', REVIEWER, '🔴 attachRef ломает фокус', '17928'),
          thread('d2', REVIEWER, 'ORDER BY без индекса', '18001'),
        ],
        pipeline: { id: '7763', status: 'failed', url: 'https://git.acme.local/p/7763' },
      },
    });

    const result = await t.recheck();

    expect(result).toEqual({ index: 0, outcome: 'sent', requestedAt: NOW });
    expect(t.reads).toEqual([MR]);
    expect(t.resumed).toHaveLength(1);
    const prompt = t.resumed[0]!.prompt;
    // Первая строка — ветка и задачи группы, как у всех слов панели группе.
    expect(prompt.split('\n')[0]).toContain('PROJ-100');
    expect(prompt).toContain('recheck its delivered MR');
    expect(prompt).toContain('The forge reports conflicts with the target branch.');
    expect(prompt).toContain(`${MR}#note_17928`);
    expect(prompt).toContain(`${MR}#note_18001`);
    expect(prompt).toContain('#7763');
    expect(prompt).toContain('4. Completeness.');
    expect(prompt).toContain('Nothing found — change nothing');
    // Отметка: идёт перепроверка, слово у сессии. Прежнюю зелёную снимает старт
    // хода (`onChainResumed`), а не нажатие: не дошло слово — она на месте.
    expect(t.group().recheckRequestedAt).toBe(NOW);
    expect(t.group().recheckSentAt).toBe(NOW);
    expect(t.group().recheckedAt).toBe('2026-10-04T08:00:00.000Z');
    // Переданное помечено: наблюдатель второй раз d2 не пошлёт.
    expect(t.group().mrWatch?.relayed).toEqual(['d1:17928', 'd2:18001']);
  });

  it('MR влит или закрыт — отказ с кодом, группе ничего не ушло', async () => {
    const merged = build({ review: { state: 'merged', threads: [] } });
    await expect(merged.recheck()).rejects.toSatisfy(
      (error) => codeOf(error) === 'split-recheck-merged',
    );
    expect(merged.resumed).toEqual([]);
    expect(merged.group().recheckRequestedAt).toBeUndefined();
    expect(merged.group().recheckedAt).toBe('old');

    const closed = build({ review: { state: 'closed', threads: [] } });
    await expect(closed.recheck()).rejects.toSatisfy(
      (error) => codeOf(error) === 'split-recheck-closed',
    );
  });

  it('фордж не ответил или читать нечем — группа читает MR сама, слово уходит', async () => {
    for (const review of [new Error('502'), undefined]) {
      const t = build(review ? { review } : {});
      await t.recheck();
      expect(t.resumed[0]?.prompt).toContain('The panel could not read the MR itself');
      expect(t.resumed[0]?.prompt).not.toContain('The forge reports conflicts');
    }
  });

  it('слово не дошло — отказ, отметки и переданное откатываются', async () => {
    const t = build({
      resume: 'refused',
      record: record([
        {
          mr: MR,
          doneAt: '2026-10-05T10:00:00.000Z',
          recheckedAt: '2026-10-04T08:00:00.000Z',
          mrWatch: { cycle: '2026-10-05T10:00:00.000Z', checks: 1 },
        },
      ]),
      review: { state: 'open', threads: [thread('d2', REVIEWER, 'ORDER BY', '18001')] },
    });
    await expect(t.recheck()).rejects.toSatisfy(
      (error) => codeOf(error) === 'split-resume-refused',
    );
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.group().recheckedAt).toBe('2026-10-04T08:00:00.000Z');
    expect(t.group().mrWatch?.relayed).toBeUndefined();
  });

  it('перепроверять нечего: копия убрана, группа не доставлена, план отменён, MR чужой', async () => {
    const cases: SplitPlanRecord[] = [
      record([{ mr: MR, cleaned: { branch: 'kept', at: NOW } }]),
      record([{ mr: MR, status: 'failed' }]),
      record([{ status: 'done' }]),
      record([{ mr: MR, deliver: false }]),
      record([{ mr: MR }], { cancelledAt: NOW }),
    ];
    const foreign = record([{ mr: MR }]);
    foreign.proposal.groups[0]!.review = { url: MR };
    cases.push(foreign);
    for (const item of cases) {
      const t = build({ record: item, review: { state: 'open', threads: [] } });
      await expect(t.recheck()).rejects.toSatisfy(
        (error) => codeOf(error) === 'split-recheck-nothing',
      );
      expect(t.resumed).toEqual([]);
      expect(t.reads).toEqual([]);
    }
  });

  it('ход перепроверки кончился доставкой — зелёная отметка со временем; новая работа её снимает', async () => {
    const t = build({ review: { state: 'open', threads: [] } });
    await t.recheck();
    t.conveyor.onChainResumed(t.link());
    expect(t.group().status).toBe('started');
    expect(t.group().recheckRequestedAt).toBe(NOW);

    t.conveyor.onChainEnded(t.link(), { status: 'done' });
    await t.flush();

    expect(t.group().status).toBe('done');
    expect(t.group().recheckedAt).toBe(NOW);
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.conveyor.view(['parent'])?.groups[0]).toMatchObject({ recheckedAt: NOW });

    // Наблюдатель MR продолжил группу по новой ветке ревьюера — проверяли не это.
    t.conveyor.onChainResumed(t.link());
    expect(t.group().recheckedAt).toBeUndefined();
  });

  it('ход перепроверки кончился сбоем доставки — перепроверка снята, зелёной нет', async () => {
    const t = build({
      review: { state: 'open', threads: [] },
      verdict: { missing: [], failed: 'git status упал' },
    });
    await t.recheck();
    t.conveyor.onChainResumed(t.link());
    t.conveyor.onChainEnded(t.link(), { status: 'done' });
    await t.flush();

    expect(t.group().status).toBe('failed');
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.group().recheckedAt).toBeUndefined();
  });
});

describe('«Продолжить» группы, остановившейся недоделанной', () => {
  const failed = (extra: Partial<SplitPlanGroupRecord> = {}): Partial<SplitPlanGroupRecord> => ({
    status: 'failed',
    error: 'Not logged in · Please run /login',
    retries: 3,
    deliveryNudges: 2,
    doneAt: '2026-10-05T10:00:00.000Z',
    ...extra,
  });

  it('сдавшаяся на сбое доступа — слово с причиной, веткой и доставкой; счёт повторов заново', () => {
    const t = build({ record: record([failed()]) });

    expect(t.conveyor.continueGroup('parent', 0)).toBe('sent');

    expect(t.resumed).toHaveLength(1);
    const prompt = t.resumed[0]!.prompt;
    expect(prompt.split('\n')[0]).toContain('PROJ-100');
    expect(prompt).toContain('its work is not finished');
    expect(prompt).toContain('Not logged in · Please run /login');
    expect(prompt).toContain('feature/g0');
    expect(prompt).toContain('open the MR (or update the existing one)');
    expect(t.group().retries).toBeUndefined();
    expect(t.group().deliveryNudges).toBeUndefined();
  });

  it('ход без вердикта ревью — тоже «Продолжить», места не спрашивает', () => {
    const t = build({
      parallel: 1,
      record: record([{ status: 'awaiting', waitingFor: 'review-missing' }]),
    });
    expect(t.conveyor.continueGroup('parent', 0)).toBe('sent');
  });

  it('сбой место отдал: потолок полон — отказ с числами, с согласием — сверх', () => {
    const t = build({ parallel: 1, record: record([failed(), { status: 'started' }]) });
    expect(() => t.conveyor.continueGroup('parent', 0)).toThrow(
      expect.objectContaining({ messageCode: 'split-group-no-slot' }),
    );
    expect(t.resumed).toEqual([]);
    expect(t.conveyor.continueGroup('parent', 0, true)).toBe('sent');
  });

  it('продолжать нечего: доставлена, копия убрана, чата нет, план отменён', () => {
    const cases: SplitPlanRecord[] = [
      record([{ status: 'done', mr: MR }]),
      record([failed({ cleaned: { branch: 'kept', at: NOW } })]),
      record([failed({ chatId: undefined })]),
      record([{ status: 'awaiting', waitingFor: 'question' }]),
      record([failed()], { cancelledAt: NOW }),
    ];
    for (const item of cases) {
      const t = build({ record: item });
      expect(() => t.conveyor.continueGroup('parent', 0)).toThrow(
        expect.objectContaining({ messageCode: 'split-continue-nothing' }),
      );
      expect(t.resumed).toEqual([]);
    }
  });

  it('продолжить нечем (сессия не принята) — отказ, счёт повторов цел', () => {
    const t = build({ resume: 'refused', record: record([failed()]) });
    expect(() => t.conveyor.continueGroup('parent', 0)).toThrow(
      expect.objectContaining({ messageCode: 'split-resume-refused' }),
    );
    expect(t.group().retries).toBe(3);
  });
});
