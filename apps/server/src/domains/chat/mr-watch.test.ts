import { describe, it, expect } from 'vitest';
import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewThread } from '../integrations/mr-review.ts';
import {
  MAX_MR_WATCH_RESUMES,
  MR_WATCH_MIN_GAP_MS,
  MR_WATCH_OFFSETS_MS,
  MrWatch,
  pendingThreads,
} from './mr-watch.ts';
import { SplitConveyor } from './split-conveyor.ts';
import type { ChatEvent } from './ChatRunner.ts';

/**
 * Наблюдатель MR после «готово» (WP1j; журнал 104, 114). Подменён только
 * фордж — ответ `read` собран из того, что отдаёт GitLab; конвейер настоящий,
 * продолжение идёт через его `resumeDelivered` до `deps.resume`.
 */

const MR = 'https://git.acme.local/team/app/-/merge_requests/810';
const DONE_AT = '2026-09-24T17:00:00.000Z';
const AUTHOR = 'rustam';
const REVIEWER = 'simonenko';

function thread(
  id: string,
  notes: [author: string, body: string, noteId: string][],
  extra: Partial<MrReviewThread> = {},
): MrReviewThread {
  return {
    id,
    resolvable: true,
    resolved: false,
    notes: notes.map(([author, body, noteId]) => ({ id: noteId, author, body })),
    ...extra,
  };
}

function review(overrides: Partial<MrReview> = {}): MrReview {
  return { state: 'open', author: AUTHOR, threads: [], ...overrides };
}

function planRecord(
  group: Partial<SplitPlanGroupRecord> = {},
  reviewUrl?: string,
): SplitPlanRecord {
  return {
    parentChatId: 'parent',
    projectPath: 'C:/repo',
    createdAt: '2026-09-24T12:00:00.000Z',
    order: [0],
    request: {},
    proposal: {
      groups: [
        {
          title: 'Фокус меню',
          branch: 'feature/focus',
          tasks: ['PROJ-1064 фокус в DropdownMenu'],
          ...(reviewUrl ? { review: { url: reviewUrl } } : {}),
        },
      ],
    },
    groups: [
      {
        index: 0,
        title: 'Фокус меню',
        branch: 'feature/focus',
        after: [],
        status: 'done',
        deliver: true,
        chatId: 'chat-g0',
        path: 'C:/wt/g0',
        mr: MR,
        doneAt: DONE_AT,
        ...group,
      },
    ],
  };
}

function build(
  options: {
    record?: SplitPlanRecord;
    reviews?: (MrReview | Error | undefined)[];
    resume?: 'sent' | 'queued' | 'refused';
    now?: string;
  } = {},
) {
  const records = new Map<string, SplitPlanRecord>();
  const initial = options.record ?? planRecord();
  records.set(initial.parentChatId, initial);
  const store = {
    get: (parent: string) => records.get(parent),
    set: (record: SplitPlanRecord) => void records.set(record.parentChatId, record),
    all: () => Object.fromEntries(records),
    findByTriage: () => undefined,
  };
  const resumed: { group: SplitPlanGroupRecord; prompt: string }[] = [];
  const conveyor = new SplitConveyor({
    store,
    launch: async () => ({ chats: [], failures: [] }),
    startTriage: () => ({ chatId: 'triage', started: false, deferred: false }),
    resume: (group, prompt) => {
      resumed.push({ group: structuredClone(group), prompt });
      return options.resume ?? 'sent';
    },
    log: () => undefined,
  });
  const timers: { run: () => void; ms: number }[] = [];
  const reads: string[] = [];
  const queue = [...(options.reviews ?? [])];
  const logs: string[] = [];
  const notices: { parent: string; event: ChatEvent }[] = [];
  const watch = new MrWatch({
    store,
    read: async (url) => {
      reads.push(url);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    resume: (parent, index, prompt) => conveyor.resumeDelivered(parent, index, prompt),
    schedule: (run, ms) => void timers.push({ run, ms }),
    now: () => new Date(options.now ?? DONE_AT),
    notify: (parent, event) => void notices.push({ parent, event }),
    log: (message) => void logs.push(message),
  });
  const group = () => records.get('parent')!.groups[0]!;
  /** Сработать ближайшему таймеру и дождаться проверки. */
  const fire = async () => {
    const timer = timers.shift();
    expect(timer, 'таймер проверки не поставлен').toBeDefined();
    timer!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { watch, conveyor, timers, reads, resumed, group, fire, logs, records, notices };
}

describe('pendingThreads: что считается замечанием группе', () => {
  it('нерешённая ветка ревьюера — да; ответ автора, бот, решённая, не решаемая — нет', () => {
    const got = pendingThreads(
      review({
        threads: [
          thread('t-open', [[REVIEWER, '🔴 attachRef ломает фокус', '17928']]),
          thread('t-answered', [
            [REVIEWER, 'ORDER BY', '17754'],
            [AUTHOR, 'поправил', '18011'],
          ]),
          {
            ...thread('t-bot', [['project_12_bot_ab', 'lint', '1']]),
            notes: [{ id: '1', author: 'project_12_bot_ab', bot: true, body: 'lint' }],
          },
          thread('t-resolved', [[REVIEWER, 'ок', '2']], { resolved: true }),
          thread('t-plain', [[REVIEWER, 'LGTM', '3']], { resolvable: false }),
        ],
      }),
      [],
    );
    expect(got.map((item) => item.id)).toEqual(['t-open']);
  });

  it('переданная реплика не передаётся второй раз, новая реплика ревьюера — снова замечание', () => {
    const first = thread('t', [[REVIEWER, 'почини', '10']]);
    expect(pendingThreads(review({ threads: [first] }), ['t:10'])).toEqual([]);
    const again = thread('t', [
      [REVIEWER, 'почини', '10'],
      [AUTHOR, 'готово', '11'],
      [REVIEWER, 'не то', '12'],
    ]);
    expect(pendingThreads(review({ threads: [again] }), ['t:10']).map((t) => t.id)).toEqual(['t']);
  });
});

describe('MrWatch: ветки ревьюера после «готово»', () => {
  it('ветка, пришедшая после «готово», продолжает группу — с веткой, задачей и требованием перечитать', async () => {
    const t = build({
      reviews: [
        review({
          threads: [
            thread('d1', [[REVIEWER, '🔴 attachRef ломает фокус во всех 5 приложениях', '17928']], {
              path: 'src/ui/Menu.tsx',
              line: 42,
            }),
          ],
        }),
      ],
    });
    t.watch.sync('parent');
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(MR_WATCH_OFFSETS_MS[0]);

    await t.fire();

    expect(t.reads).toEqual([MR]);
    expect(t.resumed).toHaveLength(1);
    const prompt = t.resumed[0]!.prompt;
    expect(prompt.split('\n')[0]).toContain('feature/focus');
    expect(prompt.split('\n')[0]).toContain('PROJ-1064');
    expect(prompt).toContain(`${MR}#note_17928`);
    expect(prompt).toContain('src/ui/Menu.tsx:42');
    expect(prompt).toContain('attachRef ломает фокус');
    expect(prompt).toContain('перечитай ВСЕ обсуждения MR');
    expect(prompt).toContain('Прежде чем снова сказать «готово», перечитай обсуждения MR ещё раз');
    expect(t.group().mrWatch).toMatchObject({ checks: 1, relayed: ['d1:17928'], resumes: 1 });
    // Продолжение ушло — следующего таймера этого круга нет: новый круг ставит новое «готово».
    expect(t.timers).toHaveLength(0);
  });

  it('новое «готово» — новый круг; уже переданная ветка второй раз не продолжает группу', async () => {
    const same = review({ threads: [thread('d1', [[REVIEWER, 'почини', '17928']])] });
    const t = build({ reviews: [same, same] });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(1);

    // Группа поработала и снова закрылась — ветка не решена, ответа нет.
    t.group().doneAt = '2026-09-24T19:00:00.000Z';
    t.watch.sync('parent');
    expect(t.group().mrWatch).toMatchObject({
      cycle: '2026-09-24T19:00:00.000Z',
      checks: 0,
      relayed: ['d1:17928'],
    });
    await t.fire();
    expect(t.resumed).toHaveLength(1);
    expect(t.timers).toHaveLength(1);
  });

  it('ответ группы в ветке — ветка ждёт ревьюера, группу не будят', async () => {
    const t = build({
      reviews: [
        review({
          threads: [
            thread('d3', [
              [REVIEWER, 'вопрос', '17770'],
              [AUTHOR, 'ответ', '18011'],
            ]),
          ],
        }),
      ],
    });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(0);
    expect(t.timers[0]!.ms).toBe(MR_WATCH_OFFSETS_MS[1]);
  });

  it('повторный sync того же круга второго таймера не ставит', () => {
    const t = build();
    t.watch.sync('parent');
    t.watch.sync('parent');
    expect(t.timers).toHaveLength(1);
  });

  it('продолжить не вышло — ничего не считается переданным, следующая проверка пробует снова', async () => {
    const found = review({ threads: [thread('d1', [[REVIEWER, 'почини', '5']])] });
    const t = build({ reviews: [found], resume: 'refused' });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(1);
    expect(t.group().mrWatch?.relayed).toBeUndefined();
    expect(t.group().mrWatch?.resumes).toBeUndefined();
    expect(t.timers).toHaveLength(1);
  });
});

describe('MrWatch: один взгляд на конвейер', () => {
  it('идущий конвейер не судится; упавший — продолжает группу; тот же конвейер второй раз — нет', async () => {
    const running = review({ pipeline: { id: '7763', status: 'running' } });
    const failed = review({
      pipeline: { id: '7763', status: 'failed', url: 'https://git.acme.local/p/7763' },
    });
    const t = build({ reviews: [running, failed, failed] });
    t.watch.sync('parent');

    await t.fire();
    expect(t.resumed).toHaveLength(0);
    expect(t.group().mrWatch?.pipeline).toBeUndefined();

    await t.fire();
    expect(t.resumed).toHaveLength(1);
    expect(t.resumed[0]!.prompt).toContain('Конвейер MR упал: №7763');
    expect(t.resumed[0]!.prompt).toContain('https://git.acme.local/p/7763');
    expect(t.group().mrWatch?.pipeline).toEqual({ id: '7763', status: 'failed' });

    // Группа ничего не отправила, закрылась снова — тот же красный конвейер уже видели.
    t.group().doneAt = '2026-09-24T20:00:00.000Z';
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(1);
  });

  it('зелёный конвейер записывается и группу не трогает', async () => {
    const t = build({ reviews: [review({ pipeline: { id: '9', status: 'success' } })] });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(0);
    expect(t.group().mrWatch?.pipeline).toEqual({ id: '9', status: 'success' });
  });
});

describe('MrWatch: расписание ограничено', () => {
  it('MR влит — наблюдение кончено, таймеров больше нет', async () => {
    const t = build({ reviews: [review({ state: 'merged' })] });
    t.watch.sync('parent');
    await t.fire();
    expect(t.group().mrWatch?.stopped).toBe('merged');
    expect(t.timers).toHaveLength(0);
  });

  it('ничего не нашлось — проверок ровно по расписанию, потом стоп', async () => {
    const t = build({ reviews: MR_WATCH_OFFSETS_MS.map(() => review()) });
    t.watch.sync('parent');
    for (let i = 0; i < MR_WATCH_OFFSETS_MS.length; i += 1) await t.fire();
    expect(t.reads).toHaveLength(MR_WATCH_OFFSETS_MS.length);
    expect(t.timers).toHaveLength(0);
    expect(t.group().mrWatch).toMatchObject({
      checks: MR_WATCH_OFFSETS_MS.length,
      stopped: 'exhausted',
    });
  });

  it('фордж не ответил — проверка засчитана, следующая по расписанию', async () => {
    const t = build({ reviews: [new Error('503')] });
    t.watch.sync('parent');
    await t.fire();
    expect(t.group().mrWatch?.checks).toBe(1);
    expect(t.timers).toHaveLength(1);
    expect(t.logs.some((line) => line.includes('forge read failed'))).toBe(true);
  });

  it('потолок продолжений — дальше только человек', async () => {
    const t = build({
      record: planRecord({
        mrWatch: { cycle: DONE_AT, checks: 0, resumes: MAX_MR_WATCH_RESUMES },
      }),
      reviews: [review({ threads: [thread('d', [[REVIEWER, 'ещё', '99']])] })],
    });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(0);
    expect(t.group().mrWatch?.stopped).toBe('limit');
    // Человек узнаёт об этом из ленты родителя, а не из журнала сервера.
    expect(t.notices).toEqual([
      {
        parent: 'parent',
        event: expect.objectContaining({
          kind: 'notice',
          code: 'mrWatchLimit',
          textCode: 'split-mr-watch-limit-notice',
          textParams: expect.objectContaining({ resumes: String(MAX_MR_WATCH_RESUMES) }),
        }),
      },
    ]);
  });

  it('после перезапуска — с той проверки, где остановились, не чаще раза в минуту', () => {
    const t = build({
      record: planRecord({ mrWatch: { cycle: DONE_AT, checks: 3 } }),
      // Панель поднялась через 5 часов после «готово»: 4-я пауза (2 ч) уже прошла.
      now: '2026-09-24T22:00:00.000Z',
    });
    t.watch.recover();
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(MR_WATCH_MIN_GAP_MS);
  });

  it('группа снова работает — проверка её не трогает', async () => {
    const t = build({ reviews: [review({ threads: [thread('d', [[REVIEWER, 'x', '1']])] })] });
    t.watch.sync('parent');
    t.group().status = 'started';
    await t.fire();
    expect(t.reads).toHaveLength(0);
    expect(t.resumed).toHaveLength(0);
  });
});

describe('MrWatch: чей MR смотрится', () => {
  it('ревью по ссылке (чужой MR), группа без доставки и убранная копия — не смотрятся', () => {
    for (const record of [
      planRecord({}, MR),
      planRecord({ deliver: false }),
      planRecord({ cleaned: { at: DONE_AT, branch: 'kept' } }),
      planRecord({ status: 'failed' }),
    ]) {
      const t = build({ record });
      t.watch.sync('parent');
      expect(t.timers).toHaveLength(0);
    }
  });

  it('resumeDelivered отказывает группе, которая уже не `done`', () => {
    const t = build({ record: planRecord({ status: 'started' }) });
    expect(t.conveyor.resumeDelivered('parent', 0, 'x')).toBe('refused');
    expect(t.resumed).toHaveLength(0);
  });
});
