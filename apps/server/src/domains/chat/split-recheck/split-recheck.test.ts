import { describe, it, expect } from 'vitest';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import type { MrReview, MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import { deliveryCheckCommand, PANEL_TESTS_CLI } from '../delivery-self-check.ts';
import {
  TASK_TICKETS,
  TASK_TICKETS_STANDING,
  type RecheckTickets,
} from '../task-tickets/task-tickets.ts';
import { SplitConveyor, type DeliveryVerdict } from '../split-conveyor/split-conveyor.ts';
import {
  CARRIED_UNCHECKED_LINE,
  OWN_OPEN_LINE,
  SIEVE_DELTA_LINE,
  UNCHANGED_HEAD_LINE,
  recheckDeliveredMr,
  type RecheckScope,
} from './split-recheck.ts';

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
    /** Охват копии (`MrRecheckDeps.scope`): значение, сбой или не задан. */
    scope?: RecheckScope | Error;
    /** Задачи трекера, перечитанные в копию (`MrRecheckDeps.tickets`): значение, сбой или не задан. */
    tickets?: RecheckTickets | Error;
    /** Новый разговор перепроверки (`SplitConveyorDeps.recheck`) и его ответ. */
    fresh?: 'sent' | 'queued' | 'refused';
    /** Лог задания у форджа (`MrRecheckDeps.jobLog`, P8): id → текст или сбой. */
    jobLog?: Record<string, string | Error>;
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
  const fresh: { index: number; prompt: string }[] = [];
  const logs: string[] = [];
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
    ...(options.fresh
      ? {
          recheck: (_record: SplitPlanRecord, group: SplitPlanGroupRecord, prompt: string) => {
            if (options.fresh !== 'refused') fresh.push({ index: group.index, prompt });
            return options.fresh ?? 'refused';
          },
        }
      : {}),
    delivery: {
      facts: async () => options.verdict ?? { missing: [], mr: MR },
      nudge: () => 'refused',
      schedule: (run) => void run(),
    },
    log: () => undefined,
    now: () => new Date(NOW),
  });
  const reads: string[] = [];
  const scopeTargets: (string | undefined)[] = [];
  const recheck = (note?: string) =>
    recheckDeliveredMr(
      {
        store,
        read: async (url) => {
          reads.push(url);
          if (options.review instanceof Error) throw options.review;
          return options.review;
        },
        recheck: (parent, index, prompt) => conveyor.recheckDelivered(parent, index, prompt),
        ...(options.jobLog
          ? {
              jobLog: async (_url: string, id: string) => {
                const found = options.jobLog?.[id];
                if (found instanceof Error) throw found;
                return found;
              },
            }
          : {}),
        ...(options.scope
          ? {
              scope: async (
                _record: SplitPlanRecord,
                _group: SplitPlanGroupRecord,
                at?: string,
              ) => {
                scopeTargets.push(at);
                if (options.scope instanceof Error) throw options.scope;
                return options.scope;
              },
            }
          : {}),
        ...(options.tickets
          ? {
              tickets: async () => {
                if (options.tickets instanceof Error) throw options.tickets;
                return options.tickets;
              },
            }
          : {}),
        log: (message) => void logs.push(message),
      },
      'parent',
      0,
      note,
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
  return {
    conveyor,
    recheck,
    resumed,
    fresh,
    logs,
    reads,
    scopeTargets,
    group,
    link,
    flush,
    records,
  };
}

const codeOf = (error: unknown) => (error as { messageCode?: string }).messageCode;

/** Строка следа задач: слово перепроверки его несёт, её ход им отчитывается. */
const TASK_ROW = {
  id: 'task-1',
  status: 'pass',
  evidence: 'src/ui/Menu.tsx:42 — pnpm test → 12 passed',
} as const;

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
    // Владелец 23.10: rebase и повторный гейт — только при настоящем конфликте.
    expect(prompt).toContain('Only on a real conflict (rc=1 or a CONFLICT line)');
    expect(prompt).toContain('Nothing changed — do not re-run the full checks.');
    expect(prompt).toContain('no conflict — leave the base as it is');
    // g0 26.10: «merge or rebase» вёл к `git merge`, который git-guard запрещает, а строки сит,
    // сданные до rebase, судья доставки признал устаревшими — лишний отказ и лишний круг.
    expect(prompt).toContain('rebase the branch onto the target and resolve it there');
    expect(prompt).toContain('`git merge` is refused by git-guard');
    expect(prompt).toContain('report them again on the new HEAD');
    expect(prompt).not.toContain('merge or rebase');
    // g0 26.10 повторная перепроверка: «trial merge on a scratch branch» звал тот же `git merge`.
    expect(prompt).toContain('cleanly (git merge-tree --write-tree).');
    expect(prompt).not.toContain('trial merge');
    // Самопроверка до ответа — той же командой, что у звена доставки, путём к CLI панели.
    expect(prompt).toContain(`Last, before you answer: run \`${deliveryCheckCommand()}\``);
    expect(prompt.indexOf('Last, before you answer')).toBeLessThan(
      prompt.indexOf('Nothing found — change nothing'),
    );
    expect(prompt).toContain(`${MR}#note_17928`);
    expect(prompt).toContain(`${MR}#note_18001`);
    expect(prompt).toContain('#7763');
    expect(prompt).toContain('4. Completeness — the group finishes its own gaps');
    expect(prompt).toContain('Task trace: first list every point of your tasks');
    // Владелец 27.10 (!1101, !1103): свои открытые находки — пробел этого MR, а не заметка.
    expect(prompt).toContain(`   ${OWN_OPEN_LINE}`);
    expect(prompt.indexOf(OWN_OPEN_LINE)).toBeLessThan(prompt.indexOf('Last, before you answer'));
    // Аудит g9 27.10 (R7): номера своих находок — из файла панели, не из старых разговоров.
    expect(OWN_OPEN_LINE).toContain(
      'keeps your review findings in .agent/run/review-findings.agent.md when the file exists ' +
        '(R-n — the cards of the fix stage, V-n — open after verification)',
    );
    // Аудит g1 27.10, F1: перенесённое «не проверено» проверяется заново; F9: шлются только изменённые строки сит.
    expect(prompt).toContain(`   ${CARRIED_UNCHECKED_LINE}`);
    expect(prompt.indexOf(CARRIED_UNCHECKED_LINE)).toBeLessThan(
      prompt.indexOf('Last, before you answer'),
    );
    expect(prompt).toContain(`\n${SIEVE_DELTA_LINE}\n`);
    expect(prompt.indexOf('Last, before you answer')).toBeLessThan(
      prompt.indexOf(SIEVE_DELTA_LINE),
    );
    expect(prompt).toContain('Nothing found — change nothing');
    // Отметка: идёт перепроверка, слово у сессии. Прежнюю зелёную снимает старт
    // хода (`onChainResumed`), а не нажатие: не дошло слово — она на месте.
    expect(t.group().recheckRequestedAt).toBe(NOW);
    expect(t.group().recheckSentAt).toBe(NOW);
    expect(t.group().recheckedAt).toBe('2026-10-04T08:00:00.000Z');
    // Переданное помечено: наблюдатель второй раз d2 не пошлёт.
    expect(t.group().mrWatch?.relayed).toEqual(['d1:17928', 'd2:18001']);
  });

  // P8 (g5 25.10): «Read the logs of the failed jobs» без строк лога — группа шла за логом
  // сама, и страж форджа такое чтение отбивал. Тот же хвост, что у наблюдателя MR.
  it('P8: красный конвейер — хвост лога упавших заданий в задании, сбой чтения не мешает', async () => {
    const trace = [
      '\u001b[32;1m$ pnpm lint\u001b[0;m',
      'section_start:1:step_script',
      ...Array.from({ length: 60 }, (_, i) => `строка ${i}`),
      'ERROR: Job failed: exit code 1',
    ].join('\n');
    const t = build({
      review: {
        state: 'open',
        threads: [],
        pipeline: {
          id: '7763',
          status: 'failed',
          failedJobs: [
            { id: '51', name: 'lint-frontend', reason: 'script_failure' },
            { id: '52', name: 'docs-gate', reason: 'script_failure' },
          ],
        },
      },
      jobLog: { '51': trace, '52': new Error('403') },
    });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain('   Tail of the log of lint-frontend (job 51) (the last 40 lines');
    // N1: лог первым, локальный прогон ничего не доказывает — как у наблюдателя MR.
    expect(prompt).toContain("   Read the failed job's log FIRST");
    expect(prompt).toContain('   No log reachable');
    expect(prompt).toContain('   ERROR: Job failed: exit code 1');
    expect(prompt).not.toContain('строка 19\n');
    expect(prompt).not.toContain('section_start');
    expect(prompt).not.toContain('Tail of the log of docs-gate');
    expect(t.logs).toContain('mr watch: job log 52 read failed');
    // Конвейер не красный — логов не читаем (сбой чтения попал бы в журнал) и хвоста нет.
    const green = build({
      review: {
        state: 'open',
        threads: [],
        pipeline: {
          id: '1',
          status: 'success',
          failedJobs: [{ id: '51', name: 'lint-frontend', reason: 'script_failure' }],
        },
      },
      jobLog: { '51': new Error('не должен читаться') },
    });
    await green.recheck();
    expect(green.resumed[0]!.prompt).not.toContain('Tail of the log');
    expect(green.logs).not.toContain('mr watch: job log 51 read failed');
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
    // След задач группа не получила — доставка строк task-N с неё не спросит.
    expect(t.group().taskTrace).toBeUndefined();
  });

  // Живой аудит 26.10: группы сдавали «готово», отдав пункты соседям, которые их не держали.
  it('полнота: свои отданные пункты, переданное соседями, заметки и соседи — списками; след задач включён', async () => {
    const plan = record([
      {
        mr: MR,
        doneAt: '2026-10-05T10:00:00.000Z',
        sieveRows: [{ id: 'task-2', status: 'n/a', evidence: 'вне скоупа, потом' }],
      },
      {
        mr: `${MR.replace('810', '811')}`,
        mrClosed: 'merged',
        sieveRows: [
          {
            id: 'task-1',
            status: 'n/a',
            evidence: 'other group: group 1 — web/src/pages/users/A.tsx',
          },
        ],
      },
    ]);
    plan.proposal.groups[0]!.owns = ['web/src/pages/users/**'];
    plan.proposal.groups[0]!.notes = 'Мержится после группы 2.';
    plan.proposal.groups[1]!.owns = ['docs/api/**'];
    plan.proposal.groups[1]!.notes = 'Группа 1 добавит ссылку на страницу ролей.';
    const t = build({ record: plan, review: { state: 'open', threads: [] } });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain('Your deferred points the panel cannot confirm');
    expect(prompt).toContain(
      '- пункт task-2 отдан мимо группы, но владелец не назван: вне скоупа, потом',
    );
    expect(prompt).toContain(
      '- Group 2 «Группа 1», task-1: other group: group 1 — web/src/pages/users/A.tsx',
    );
    expect(prompt).toContain('- Group 2 «Группа 1»: Группа 1 добавит ссылку на страницу ролей.');
    expect(prompt).toContain('- Мержится после группы 2.');
    expect(prompt).toContain('- Group 2 «Группа 1»: done, MR');
    expect(prompt).toContain('(merged); owns docs/api/**');
    expect(t.group().taskTrace).toBe(true);
    // Ход перепроверки оставил прежнее «вне скоупа» — не готово, пробел называет пункт.
    t.conveyor.onChainResumed(t.link());
    t.conveyor.onChainEnded(t.link(), { status: 'done' });
    await t.flush();
    expect(t.group().status).not.toBe('done');
    expect(t.group().deliveryMissing).toEqual([
      expect.stringContaining('пункт task-2 отдан мимо группы, но владелец не назван'),
    ]);
  });

  it('ход перепроверки без единой строки task-N — не готово: «нет отчёта по пунктам задач»', async () => {
    const t = build({ review: { state: 'open', threads: [] } });
    await t.recheck();
    t.conveyor.onChainResumed(t.link());
    t.conveyor.onChainEnded(t.link(), { status: 'done' });
    await t.flush();
    expect(t.group().status).not.toBe('done');
    expect(t.group().deliveryMissing).toEqual([
      expect.stringContaining('нет отчёта по пунктам задач группы'),
    ]);
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

    t.conveyor.onChainEnded(t.link(), { status: 'done', sieveRows: [TASK_ROW] });
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

describe('«Перепроверить MR»: охват и новый разговор (R2/R5, 19.10)', () => {
  const scope = (files: number, outside: number): RecheckScope => ({
    base: 'origin/main',
    files: Array.from({ length: files }, (_, index) => `web/f${index}.tsx`),
    outside: Array.from({ length: outside }, (_, index) => `svc/o${index}.go`),
  });

  it('охват: длинный — счётом и командой, без списка; файлы мимо него — головой и «+N more»', async () => {
    const t = build({ scope: scope(45, 23) });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain(
      'changes against origin/main count (git diff --name-only origin/main...HEAD)',
    );
    expect(prompt).toContain('In scope: 45 files — that command lists them.');
    expect(prompt).not.toContain('   - web/f0.tsx');
    expect(prompt).toContain('not part of this MR (23):');
    expect(prompt).toContain('   - svc/o19.go');
    expect(prompt).not.toContain('   - svc/o20.go');
    expect(prompt).toContain('   - +3 more');
    expect(prompt).toContain('never git add -A, git add . or commit -a');
  });

  // Живой прогон 27.10: три перепроверки дали `mr_discussions` jmespath без `items` — отказ.
  it('шаг обсуждений называет форму ответа mr_discussions', async () => {
    const t = build({ review: { state: 'open', threads: [] } });
    await t.recheck();
    expect(t.resumed[0]!.prompt).toContain(
      '`mr_discussions` answers `{items: […], pagination}` — a jmespath starts at `items`',
    );
  });

  // Живой прогон 27.10: база охвата бралась от ветки, выгруженной в папке проекта.
  it('охват считается против цели MR от форджа; MR не прочитан — цели нет', async () => {
    const read = build({
      scope: scope(1, 0),
      review: { state: 'open', threads: [], targetBranch: 'main' },
    });
    await read.recheck();
    expect(read.scopeTargets).toEqual(['main']);
    const unread = build({ scope: scope(1, 0), review: new Error('forge down') });
    await unread.recheck();
    expect(unread.scopeTargets).toEqual([undefined]);
  });

  it('ровно на границе: 20 — списком целиком, 21 — счётом', async () => {
    const full = build({ scope: scope(20, 20) });
    await full.recheck();
    expect(full.resumed[0]!.prompt).not.toMatch(/\+\d+ more/);
    expect(full.resumed[0]!.prompt).toContain('In scope (20):');
    expect(full.resumed[0]!.prompt).toContain('   - web/f19.tsx');
    const over = build({ scope: scope(21, 21) });
    await over.recheck();
    const prompt = over.resumed[0]!.prompt;
    expect(prompt).toContain('In scope: 21 files');
    expect(prompt).not.toContain('   - web/f0.tsx');
    expect(prompt.match(/ {3}- \+1 more/g)).toHaveLength(1);
  });

  it('правки — первыми, проверки и пуш — раз после последней; проба конфликта — одной командой', async () => {
    const t = build({ scope: scope(2, 0) });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain(
      'One probe: `git merge-tree --write-tree origin/main HEAD > .agent/tmp/merge-tree.txt; echo rc=$?;',
    );
    expect(prompt).toContain('This step runs no checks.');
    expect(prompt).not.toContain('then run the checks again');
    const order = prompt.indexOf('Make every code change of this recheck first');
    expect(order).toBeGreaterThan(prompt.indexOf('1. Conflicts.'));
    expect(prompt).toContain('run the checks of the scope ONCE and push ONCE');
    expect(prompt).toContain('no hand-run go test / pytest / vitest of the same zone before it');
    // Как сдать «стенда нет» — в самой вводной, до самопроверки (аудит g5 27.10, M1).
    const waiver = prompt.indexOf('is recorded as blocked, not left unrun');
    expect(waiver).toBeGreaterThan(prompt.indexOf('4. Completeness'));
    expect(waiver).toBeLessThan(prompt.indexOf('Last, before you answer'));
  });

  it('пустой охват — «none», мимо охвата нет — строки о нём нет', async () => {
    const t = build({ scope: scope(0, 0) });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain('In scope (0):\n   - none');
    expect(prompt).not.toContain('Outside the scope');
  });

  it('охват не задан или не прочитан — правила без списка, сбой в журнале, слово уходит', async () => {
    const none = build();
    await none.recheck();
    expect(none.resumed[0]!.prompt).toContain(
      'against the MR target count (git diff --name-only <target>...HEAD)',
    );
    expect(none.resumed[0]!.prompt).toContain('Stage paths by name');

    const broken = build({ scope: new Error('git died') });
    await expect(broken.recheck()).resolves.toMatchObject({ outcome: 'sent' });
    expect(broken.logs).toContain('mr recheck: scope unreadable');
    expect(broken.resumed[0]!.prompt).toContain('<target>...HEAD');
  });

  it('новый разговор задан — слово перепроверки идёт в него, не продолжением сессии', async () => {
    const t = build({ fresh: 'sent' });
    await expect(t.recheck()).resolves.toMatchObject({ outcome: 'sent' });
    expect(t.fresh).toHaveLength(1);
    expect(t.fresh[0]!.prompt).toContain('recheck its delivered MR');
    expect(t.resumed).toEqual([]);
    expect(t.group().recheckSentAt).toBe(NOW);
  });

  it('новый разговор отказал — отметка перепроверки снята, отказ с кодом', async () => {
    const t = build({ fresh: 'refused' });
    await expect(t.recheck()).rejects.toSatisfy(
      (error) => codeOf(error) === 'split-resume-refused',
    );
    expect(t.resumed).toEqual([]);
    expect(t.group().recheckRequestedAt).toBeUndefined();
    expect(t.group().recheckSentAt).toBeUndefined();
    expect(t.group().recheckedAt).toBe('old');
  });
});

/**
 * Аудит g0 26.10. F3: «прочесть каждый тикет целиком» стоило девять чтений через MCP, и
 * группа не прочла ни одного — панель перечитывает задачи в копию и делит их на
 * изменённые после доставки и прежние. F5: гейт проекта блок «Тесты» не пишет, и после
 * rebase кейсы оказывались непрогнанными только на круге доставки.
 */
describe('«Перепроверить MR»: задачи трекера и блок «Тесты» после rebase (g0 F3/F5)', () => {
  const tickets: RecheckTickets = {
    at: '2026-10-26T15:30:00.000Z',
    since: '2026-10-26T15:00:00.000Z',
    changed: [{ key: 'PROJ-7', updatedAt: '2026-10-26T18:09:25.123+0300' }],
    unchanged: ['PROJ-100', 'PROJ-8'],
    unread: ['PROJ-9 — 403'],
  };

  it('задачи перечитаны — шаг полноты называет файл и делит задачи; «прочтите каждый тикет» нет', async () => {
    const t = build({ tickets });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain(
      `The panel re-read the tracker tickets of your tasks at 2026-10-26T15:30:00.000Z into \`${TASK_TICKETS}\``,
    );
    expect(prompt).toContain('do not call the tracker for them');
    expect(prompt).toContain(
      'Updated in the tracker since the last delivery (2026-10-26T15:00:00.000Z) — derive their ' +
        'points anew from their sections (Grep `^## <KEY>`, then Read that range; never the whole ' +
        'file): PROJ-7 (updated 2026-10-26T18:09:25.123+0300).',
    );
    // Аудит g1 27.10, F2: с кодом сверять, только если HEAD сдвинулся после доставки.
    // Аудит g9 27.10, R6: в файле у них указатель, полный текст — в соседнем файле.
    expect(prompt).toContain(
      'their points stand as reported; the file holds only a pointer line for each (full text in ' +
        `\`${TASK_TICKETS_STANDING}\`, only to quote a point again): PROJ-100, PROJ-8. ${UNCHANGED_HEAD_LINE}`,
    );
    expect(prompt).not.toContain('re-check each against the code');
    // g8 26.10: «прочтите файл целиком» при неизменных задачах — 44 KB, отказы и 32k в окно.
    expect(prompt).not.toContain('read that file');
    expect(prompt).toContain('Not in the file — read these in the tracker: PROJ-9 — 403.');
    expect(prompt).not.toContain('Read every tracker ticket your tasks link, in full.');
    // Строки задач — внутри шага полноты, до следа задач.
    expect(prompt.indexOf('4. Completeness')).toBeLessThan(prompt.indexOf('The panel re-read'));
    expect(prompt.indexOf('The panel re-read')).toBeLessThan(prompt.indexOf('Task trace:'));
  });

  /**
   * Аудит g5 27.10 (H1): «пункты прежних задач стоят как сданы» при 7 строках на 37 пунктов —
   * PDF из комментариев владельца не назвал никто. Непокрытые пункты — в задании дословно,
   * до предела; хвост — счётом.
   */
  it('прежние задачи с непокрытыми пунктами — пункты дословно с ключом, сверх 24 — счётом', async () => {
    const points = Array.from({ length: 26 }, (_, i) => `Пункт ${i + 1} задачи`);
    const t = build({
      tickets: {
        ...tickets,
        owed: [
          { key: 'PROJ-5', points: ['Нужен PDF «Отчёт для дизайна»'] },
          { key: 'PROJ-6', points },
        ],
      },
    });
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain(
      'but no reported task-N row quotes these points of theirs — do each in this branch now',
    );
    expect(prompt).toContain('   - PROJ-5: «Нужен PDF «Отчёт для дизайна»»');
    expect(prompt).toContain('   - PROJ-6: «Пункт 23 задачи»');
    expect(prompt).not.toContain('«Пункт 24 задачи»');
    expect(prompt).toContain('   - +3 more — in those sections');
  });

  it('заметка человека — в задании дословно, построчно, до проверок; пустая — блока нет', async () => {
    const t = build({ tickets });
    await t.recheck('  Нужен PDF «Отчёт для дизайна».\nИ кнопка экспорта в шапке  ');
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain('The human added a note to this recheck, quoted verbatim below.');
    expect(prompt).toContain(
      '   > Нужен PDF «Отчёт для дизайна».\n   > И кнопка экспорта в шапке\n',
    );
    expect(prompt.indexOf('The human added a note')).toBeLessThan(
      prompt.indexOf('4. Completeness'),
    );

    const blank = build({ tickets });
    await blank.recheck('   ');
    expect(blank.resumed[0]!.prompt).not.toContain('The human added a note');
  });

  it('трекер не задан или не ответил — прежняя строка «прочтите каждый тикет», сбой в журнале, слово уходит', async () => {
    const none = build();
    await none.recheck();
    expect(none.resumed[0]!.prompt).toContain(
      'Read every tracker ticket your tasks link, in full.',
    );
    expect(none.resumed[0]!.prompt).not.toContain('The panel re-read');

    const broken = build({ tickets: new Error('jira down') });
    await broken.recheck();
    expect(broken.resumed).toHaveLength(1);
    expect(broken.resumed[0]!.prompt).toContain('Read every tracker ticket your tasks link');
    expect(broken.logs).toContain('mr recheck: tracker tickets unreadable');
  });

  it('прогон непрогнанных кейсов блока «Тесты» — один, в проходе после последней правки, путём к CLI панели', async () => {
    const t = build();
    await t.recheck();
    const prompt = t.resumed[0]!.prompt;
    expect(prompt).toContain(
      `The touched-zone test run is \`node "${PANEL_TESTS_CLI}" run --project . --stale\`, once, in that pass`,
    );
    expect(prompt).toContain('cite its run id in the sieve rows');
    // Строка — сразу за правилом «правки первыми», до замечаний ревьюера.
    const run = prompt.indexOf('The touched-zone test run');
    expect(run).toBeGreaterThan(prompt.indexOf('Make every code change of this recheck first'));
    expect(run).toBeLessThan(prompt.indexOf('2. Reviewer comments.'));
  });
});
