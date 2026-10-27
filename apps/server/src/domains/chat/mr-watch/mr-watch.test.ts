import { describe, it, expect } from 'vitest';
import { LEARN_SIEVES_LINE } from '@agentdeck/contracts/sieves';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import {
  MAX_MR_WATCH_RESUMES,
  MR_WATCH_MIN_GAP_MS,
  MR_WATCH_OFFSETS_MS,
  MrWatch,
  jobLogTail,
  pendingThreads,
} from './mr-watch.ts';
import { SplitConveyor } from '../split-conveyor/split-conveyor.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';

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
    /** Ответ форджа на повтор задания; нет — повторять нечем (GitHub, нет токена). */
    retry?: (jobId: string) => Promise<boolean>;
    /** Лог задания у форджа (P8); нет — читать нечем. */
    jobLog?: (jobId: string) => Promise<string | undefined>;
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
  const retried: string[] = [];
  const retry = options.retry;
  const jobLog = options.jobLog;
  const logReads: string[] = [];
  const watch = new MrWatch({
    ...(jobLog
      ? {
          jobLog: (_url: string, jobId: string) => {
            logReads.push(jobId);
            return jobLog(jobId);
          },
        }
      : {}),
    ...(retry
      ? {
          retryJob: (_url: string, jobId: string) => {
            retried.push(jobId);
            return retry(jobId);
          },
        }
      : {}),
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
  return {
    watch,
    conveyor,
    timers,
    reads,
    resumed,
    group,
    fire,
    logs,
    records,
    notices,
    retried,
    logReads,
  };
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
    expect(prompt).toContain('re-read EVERY unresolved MR discussion');
    expect(prompt).toContain('Before saying "done" again, re-read the MR discussions once more');
    expect(t.group().mrWatch).toMatchObject({ checks: 1, relayed: ['d1:17928'], resumes: 1 });
    // Тред — блокер, ушедший в MR: группа раскладывает его в сито, а ссылка,
    // по которой панель потом примет сито, записана ровно как в задании.
    expect(prompt).toContain(LEARN_SIEVES_LINE);
    expect(t.group().mrWatch?.relayedLinks).toEqual([`${MR}#note_17928`]);
    // Файл треда — область сита, которое из него выучат (сито по путям).
    expect(t.group().mrWatch?.relayedPaths).toEqual({ [`${MR}#note_17928`]: 'src/ui/Menu.tsx' });
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
    // Ссылки переданного переживают круг: сито, сданное ходом позже, ещё принимается.
    expect(t.group().mrWatch).toMatchObject({
      cycle: '2026-09-24T19:00:00.000Z',
      checks: 0,
      relayed: ['d1:17928'],
      relayedLinks: [`${MR}#note_17928`],
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
    expect(t.resumed[0]!.prompt).toContain('The MR pipeline failed: #7763');
    expect(t.resumed[0]!.prompt).toContain('https://git.acme.local/p/7763');
    expect(t.group().mrWatch?.pipeline).toEqual({ id: '7763', status: 'failed' });

    // Группа ничего не отправила, закрылась снова — тот же красный конвейер уже видели.
    t.group().doneAt = '2026-09-24T20:00:00.000Z';
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(1);
  });

  // P8 (g5 25.10): «Read the logs of the failed jobs» без единой строки лога — группа
  // полезла в фордж за логом, страж отбил чтение, и она гоняла CI вслепую у себя.
  it('P8: хвост лога упавших заданий — в продолжении, ≤ 40 строк на задание, ≤ 2 задания', async () => {
    const ESC = String.fromCharCode(27);
    const trace = (name: string) =>
      [
        `${ESC}[0Ksection_start:1761400000:step_script\r${ESC}[0K${ESC}[36;1mExecuting "step_script"${ESC}[0;m`,
        ...Array.from({ length: 120 }, (_, i) => `${ESC}[31m${name}-line-${i + 1}${ESC}[0m`),
        `section_end:1761400100:step_script\r${ESC}[0K`,
        `${ESC}[31;1mERROR: Job failed: exit code 1${ESC}[0;m`,
        '',
      ].join('\n');
    const failed = review({
      pipeline: {
        id: '11893',
        status: 'failed',
        failedJobs: [
          { id: '1', name: 'test-frontend', reason: 'script_failure' },
          { id: '2', name: 'lint', reason: 'script_failure' },
          { id: '3', name: 'docs', reason: 'script_failure' },
        ],
      },
    });
    const names: Record<string, string> = { '1': 'test-frontend', '2': 'lint', '3': 'docs' };
    const t = build({
      reviews: [failed],
      jobLog: async (jobId) => trace(names[jobId] ?? jobId),
    });
    t.watch.sync('parent');
    await t.fire();

    expect(t.resumed).toHaveLength(1);
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain('The MR pipeline failed: #11893');
    expect(prompt).toContain('test-frontend-line-120');
    expect(prompt).toContain('lint-line-120');
    expect(prompt).toContain('ERROR: Job failed: exit code 1');
    // Хвост, а не весь лог; третье задание не читается; без управляющих кодов терминала.
    expect(prompt).not.toContain('test-frontend-line-80\n');
    expect(prompt).toContain('test-frontend-line-82');
    expect(prompt).not.toContain('docs-line-');
    expect(t.logReads).toEqual(['1', '2']);
    expect(prompt).not.toContain(ESC);
    expect(prompt).not.toContain('section_end:');
    expect(prompt.length).toBeLessThan(6_000);
  });

  it('P8: лог не прочёлся — продолжение уходит как раньше, без хвоста', async () => {
    const failed = review({
      pipeline: {
        id: '7763',
        status: 'failed',
        failedJobs: [{ id: '1', name: 'test-frontend', reason: 'script_failure' }],
      },
    });
    const t = build({
      reviews: [failed],
      jobLog: async () => {
        throw new Error('403');
      },
    });
    t.watch.sync('parent');
    await t.fire();
    expect(t.resumed).toHaveLength(1);
    expect(t.resumed[0]!.prompt).toContain('Failed jobs: test-frontend (script_failure, job 1).');
    expect(t.resumed[0]!.prompt).not.toContain('Tail of the log');
  });

  // N1 + N7 (g5 25.10): группа 20 минут гоняла CI у себя вместо одного чтения лога, а
  // описание задания искала тремя поисками — CI-конфиг жил не в .gitlab-ci.yml.
  it('N1: красный — лог первым по номеру задания, локальный прогон ничего не доказывает, лога нет — сказать сразу', async () => {
    const failed = review({
      pipeline: {
        id: '11893',
        status: 'failed',
        failedJobs: [{ id: '217476', name: 'test-frontend', reason: 'script_failure' }],
      },
    });
    const t = build({ reviews: [failed], jobLog: async () => 'FAIL src/a.test.tsx\nexit 1' });
    t.watch.sync('parent');
    await t.fire();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain("Read the failed job's log FIRST");
    expect(prompt).toContain('A local re-run proves neither a fix nor');
    expect(prompt).toMatch(
      /No log reachable .* report that gap to the human at once and run nothing/,
    );
    expect(prompt).toContain('Tail of the log of test-frontend (job 217476)');
    expect(prompt).toContain('Failed jobs: test-frontend (script_failure, job 217476).');
    expect(prompt).toContain("`git grep -n 'test-frontend:' -- '*.yml' '*.yaml'`");
    // Лог — раньше любого другого шага: строка о логе идёт до хвоста и до правил ответа.
    expect(prompt.indexOf('log FIRST')).toBeLessThan(prompt.indexOf('Tail of the log'));
  });

  describe('E3: CI упал на инфраструктуре — модель не будится', () => {
    const job = (id: string, name: string, reason?: string) => ({
      id,
      name,
      ...(reason ? { reason } : {}),
    });
    const red = (...failedJobs: ReturnType<typeof job>[]) =>
      review({ pipeline: { id: '7763', status: 'failed', failedJobs } });
    const infraNotices = (t: ReturnType<typeof build>) =>
      t.notices.filter(({ event }) => event.kind === 'notice' && event.code === 'mrWatchInfra');

    it('умер раннер — панель повторяет задание сама; повтор упал так же — заметка, без второго повтора', async () => {
      const t = build({
        reviews: [
          red(job('51', 'lint-frontend', 'runner_system_failure')),
          red(job('54', 'lint-frontend', 'runner_system_failure')),
          red(job('54', 'lint-frontend', 'runner_system_failure')),
        ],
        retry: async () => true,
      });
      t.watch.sync('parent');

      await t.fire();
      expect(t.resumed).toHaveLength(0);
      expect(t.retried).toEqual(['51']);
      // Взгляд на конвейер не записан: исход повтора судится следующей проверкой.
      expect(t.group().mrWatch?.pipeline).toBeUndefined();
      expect(t.group().mrWatch?.infraRetried).toEqual(['7763:lint-frontend']);
      const first = infraNotices(t);
      expect(first).toHaveLength(1);
      expect(first[0]!.event).toMatchObject({
        textCode: 'split-mr-watch-infra-retry-notice',
        textParams: { jobs: 'lint-frontend (runner_system_failure)' },
      });

      await t.fire();
      expect(t.resumed).toHaveLength(0);
      expect(t.retried).toEqual(['51']);
      expect(infraNotices(t).at(-1)!.event).toMatchObject({
        textCode: 'split-mr-watch-infra-again-notice',
      });
      expect(t.group().mrWatch?.pipeline).toEqual({ id: '7763', status: 'failed' });

      // Тот же конвейер третий раз не судится вовсе.
      await t.fire();
      expect(infraNotices(t)).toHaveLength(2);
      expect(t.resumed).toHaveLength(0);
    });

    it('хоть одно задание упало на коде — будится группа, причины заданий в слове, повтора нет', async () => {
      const t = build({
        reviews: [
          red(
            job('51', 'lint-frontend', 'runner_system_failure'),
            job('52', 'docs-gate', 'script_failure'),
          ),
        ],
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual([]);
      expect(t.resumed).toHaveLength(1);
      expect(t.resumed[0]!.prompt).toContain(
        'Failed jobs: lint-frontend (runner_system_failure, job 51), docs-gate (script_failure, job 52).',
      );
    });

    it('причина неизвестна у одного задания — судит группа', async () => {
      const t = build({
        reviews: [red(job('51', 'lint', 'runner_system_failure'), job('52', 'test'))],
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual([]);
      expect(t.resumed).toHaveLength(1);
    });

    it('фордж повтор не принял — красный судится группой, как до E3', async () => {
      const t = build({
        reviews: [red(job('51', 'lint-frontend', 'runner_system_failure'))],
        retry: async () => {
          throw new Error('403 Forbidden');
        },
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual(['51']);
      expect(t.resumed).toHaveLength(1);
      expect(t.resumed[0]!.prompt).toContain('The MR pipeline failed: #7763');
      expect(t.group().mrWatch?.infraRetried).toBeUndefined();
      expect(t.group().mrWatch?.pipeline).toEqual({ id: '7763', status: 'failed' });
      expect(infraNotices(t)).toHaveLength(0);
    });

    it('повторять нечем (GitHub, нет токена) — красный судится группой', async () => {
      const t = build({ reviews: [red(job('51', 'lint', 'runner_system_failure'))] });
      t.watch.sync('parent');
      await t.fire();
      expect(t.resumed).toHaveLength(1);
    });

    // g1 26.10, конвейер 12035: semgrep-scan 25 минут ждал узел и упал `job_execution_timeout` —
    // группа получила вводную в 26 тыс. знаков, ход в 426 тыс. токенов и ожидание человека.
    const stamp = (s: number, stream: string, text: string) =>
      `2026-10-26T13:${String(30 + Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000000Z 00${stream} ${text}`;
    const podWait = (seconds: number) =>
      Array.from({ length: seconds / 3 }, (_, i) => [
        stamp(
          i * 3,
          'E',
          'Waiting for pod gitlab-runner/runner-x to be running, status is Pending',
        ),
        stamp(i * 3, 'E', '\tUnschedulable: "0/30 nodes are available: 30 Insufficient cpu."'),
      ]).flat();
    const neverStarted = [
      stamp(
        0,
        'O',
        'section_start:1793021440:prepare_executor\r\u001b[0K\u001b[0K\u001b[36;1mPreparing the "kubernetes" executor\u001b[0;m',
      ),
      stamp(1, 'O', 'section_end:1793021441:prepare_executor\r\u001b[0K'),
      stamp(2, 'O', 'section_start:1793021442:prepare_script\r\u001b[0K'),
      ...podWait(90),
      stamp(1500, 'O', 'section_end:1793022943:prepare_script\r\u001b[0K'),
      stamp(
        1500,
        'O',
        '+WARNING: prepare_script could not run to completion because the timeout was exceeded.',
      ),
      stamp(1500, 'O', 'ERROR: Job failed: execution took longer than 25m0s seconds'),
    ].join('\n');

    it('таймаут, за который скрипт так и не начался (под ждал узел), — машина CI: повторяет панель', async () => {
      const t = build({
        reviews: [red(job('219932', 'semgrep-scan', 'job_execution_timeout'))],
        jobLog: async () => neverStarted,
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.resumed).toHaveLength(0);
      expect(t.retried).toEqual(['219932']);
      expect(infraNotices(t)[0]!.event).toMatchObject({
        textCode: 'split-mr-watch-infra-retry-notice',
        textParams: { jobs: 'semgrep-scan (job_execution_timeout)' },
      });
    });

    it('таймаут посреди скрипта (тесты зависли) — дело кода: судит группа, лог читается один раз', async () => {
      const hung = [
        stamp(0, 'O', 'section_start:1793021440:prepare_script\r\u001b[0K'),
        stamp(5, 'O', 'section_start:1793021445:step_script\r\u001b[0K'),
        stamp(6, 'O', '$ pnpm test'),
        stamp(1500, 'O', 'ERROR: Job failed: execution took longer than 25m0s seconds'),
      ].join('\n');
      const t = build({
        reviews: [red(job('7', 'test-frontend', 'job_execution_timeout'))],
        jobLog: async () => hung,
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual([]);
      expect(t.resumed).toHaveLength(1);
      expect(t.resumed[0]!.prompt).toContain('$ pnpm test');
      expect(t.logReads).toEqual(['7']);
    });

    it('таймаут, а лог не прочёлся — не доказано: судит группа', async () => {
      const t = build({
        reviews: [red(job('7', 'semgrep-scan', 'job_execution_timeout'))],
        jobLog: async () => {
          throw new Error('403');
        },
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual([]);
      expect(t.resumed).toHaveLength(1);
    });

    it('хвост лога: повторы ожидания раннера свёрнуты в «(×N)», метки разделов с временем убраны', () => {
      const tail = jobLogTail(neverStarted);
      expect(tail).toEqual([
        expect.stringMatching(/Preparing the "kubernetes" executor$/),
        expect.stringMatching(/Waiting for pod .* status is Pending \(×30\)$/),
        expect.stringMatching(/Unschedulable: .*Insufficient cpu\." \(×30\)$/),
        expect.stringMatching(/WARNING: prepare_script could not run/),
        expect.stringMatching(/ERROR: Job failed: execution took longer than 25m0s/),
      ]);
      expect(tail.join('\n').length).toBeLessThan(800);
    });

    it('ветки ревьюера и умерший раннер — группа будится ради веток, красного в слове нет', async () => {
      const t = build({
        reviews: [
          review({
            threads: [thread('d1', [['simonenko', 'Поправь', 'n1']])],
            pipeline: {
              id: '7763',
              status: 'failed',
              failedJobs: [job('51', 'lint', 'runner_system_failure')],
            },
          }),
          red(job('54', 'lint', 'runner_system_failure')),
        ],
        retry: async () => true,
      });
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual(['51']);
      expect(t.resumed).toHaveLength(1);
      expect(t.resumed[0]!.prompt).toContain('Поправь');
      expect(t.resumed[0]!.prompt).not.toContain('The MR pipeline failed');

      // Группа ответила и закрылась снова — новый круг помнит повтор: вторая
      // смерть того же задания — заметка, а не второй повтор.
      t.group().status = 'done';
      t.group().doneAt = '2026-09-24T20:00:00.000Z';
      t.watch.sync('parent');
      await t.fire();
      expect(t.retried).toEqual(['51']);
      expect(infraNotices(t).at(-1)!.event).toMatchObject({
        textCode: 'split-mr-watch-infra-again-notice',
      });
    });
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
