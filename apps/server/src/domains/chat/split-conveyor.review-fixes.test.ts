import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import { readDeliveryFacts, missingDelivery } from '../project-git/delivery-facts.ts';
import {
  copyRootOf,
  SplitConveyor,
  type ChainOutcome,
  type SplitConveyorDeps,
  type SplitDeliveryDeps,
} from './split-conveyor.ts';

/**
 * Правки финального ревью конвейера разделения (25.09.2026): место ждущей
 * группы (M7), перезапуск отменённого плана (m1) и остатки прошлой жизни группы
 * (m2), сбой чтения копии при проверке доставки (m5), путь настроек и корень
 * копий (m6), лимит подписки по провайдеру (m11), настоящий итог отложенного
 * продолжения (m12). Конвейер настоящий; снаружи — запуск копий, продолжение
 * сессии и часы; в m5 — настоящий `readDeliveryFacts` над каталогом без git.
 */

const PARENT = 'родитель';
const FOREIGN = foreignChatKey('codex', 'c-1');
const START = Date.UTC(2026, 8, 25, 10, 0);

const PROPOSAL = {
  groups: [
    { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] },
    { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 вторая'] },
    { title: 'Три', branch: 'feature/three', tasks: ['PROJ-3 третья'] },
  ],
};

interface Timer {
  at: number;
  run: () => void;
}

function build(
  options: {
    parallel?: number;
    groups?: number;
    refuse?: boolean;
    delivery?: SplitDeliveryDeps;
  } = {},
) {
  const records = new Map<string, SplitPlanRecord>();
  const launches: { parent: string; groups: number[] }[] = [];
  const resumed: { parent: string; index: number }[] = [];
  const timers: Timer[] = [];
  const clock = { now: START };
  const proposal = { groups: PROPOSAL.groups.slice(0, options.groups ?? 3) };
  const deps: SplitConveyorDeps = {
    store: {
      get: (parent) => {
        const record = records.get(parent);
        return record ? structuredClone(record) : undefined;
      },
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) => {
        const record = [...records.values()].find((item) => ids.includes(item.triageChatId ?? ''));
        return record ? structuredClone(record) : undefined;
      },
      all: () =>
        Object.fromEntries([...records].map(([key, value]) => [key, structuredClone(value)])),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => {
      launches.push({ parent: record.parentChatId, groups });
      return {
        chats: groups.map((index) => ({
          index,
          title: record.proposal.groups[index]?.title ?? '',
          branch: record.groups[index]?.branch ?? '',
          chatId: `${record.parentChatId}-chat-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: true,
          prompt: '',
          ...(options.delivery ? { deliver: true } : {}),
        })),
        failures: [],
      };
    },
    startTriage: (record) => ({
      chatId: `triage-${record.parentChatId}`,
      started: true,
      deferred: false,
    }),
    ...(options.parallel ? { parallel: () => options.parallel as number } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    resume: (group) => {
      if (options.refuse) return 'refused';
      const parent = [...records.values()].find((record) =>
        record.groups.some((item) => item.chatId === group.chatId),
      );
      resumed.push({ parent: parent?.parentChatId ?? '', index: group.index });
      return 'sent';
    },
    schedule: (run, ms) => {
      timers.push({ at: clock.now + ms, run });
      return timers.length;
    },
    log: () => undefined,
    now: () => new Date(clock.now),
  };
  const conveyor = new SplitConveyor(deps);
  const link = (index: number, parent = PARENT): ChatLink => ({
    parentChatId: parent,
    createdAt: '',
    branch: proposal.groups[index]?.branch ?? '',
    groupIndex: index,
    stage: 'work',
  });
  const flush = () => new Promise((done) => setTimeout(done, 5));
  /** Разбор применён без блока: все группы в очереди по порядку. */
  const begin = async (parent = PARENT, extra: { copyRoot?: string } = {}): Promise<void> => {
    await conveyor.begin({
      parentChatId: parent,
      projectPath: 'C:/repo/app',
      ...extra,
      proposal,
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, [`triage-${parent}`]);
    await flush();
  };
  const advance = async (ms: number): Promise<void> => {
    clock.now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= clock.now);
      if (due.length === 0) break;
      for (const timer of due) timers.splice(timers.indexOf(timer), 1);
      for (const timer of due) timer.run();
      await flush();
    }
  };
  const group = (index: number, parent = PARENT) => records.get(parent)?.groups[index];
  const edit = (parent: string, change: (record: SplitPlanRecord) => void): void => {
    const record = records.get(parent);
    if (!record) throw new Error('нет записи');
    change(record);
    records.set(parent, record);
  };
  const launched = (parent = PARENT) =>
    launches.filter((item) => item.parent === parent).map((item) => item.groups);
  return {
    conveyor,
    records,
    resumed,
    timers,
    link,
    flush,
    begin,
    advance,
    group,
    edit,
    launched,
  };
}

const limitOutcome = (at: number): ChainOutcome => ({
  status: 'awaiting',
  waitingFor: 'limit',
  limitUntil: new Date(at).toISOString(),
});

describe('M7: ждущая человека группа держит место', () => {
  it('вопрос человеку не отдаёт место очереди; ответ продолжает её, не превышая потолка', async () => {
    const t = build({ parallel: 1, groups: 2 });
    await t.begin();
    expect(t.launched()).toEqual([[0]]);

    t.conveyor.onChainEnded(t.link(0), { status: 'awaiting', waitingFor: 'question' });
    await t.flush();
    // Место за ней: вторая стоит в очереди, работающих не больше потолка.
    expect(t.launched()).toEqual([[0]]);
    expect(t.group(1)?.status).toBe('pending');

    // Ответ человека — прогон в её чате, в её же месте.
    t.conveyor.onChainResumed(t.link(0), `${PARENT}-chat-0`);
    expect(t.group(0)?.status).toBe('started');
    expect(t.launched()).toEqual([[0]]);

    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    expect(t.launched()).toEqual([[0], [1]]);
  });

  it('решение человека (decision) держит место так же', async () => {
    const t = build({ parallel: 1, groups: 2 });
    await t.begin();
    t.conveyor.onChainEnded(t.link(0), { status: 'awaiting', waitingFor: 'decision' });
    await t.flush();
    expect(t.launched()).toEqual([[0]]);
    await expect(t.conveyor.startNow(PARENT, 1)).rejects.toMatchObject({
      messageCode: 'split-group-no-slot',
    });
  });
});

describe('m1/m2/m6: перезапуск из итога разбора', () => {
  it('отменённый план не перезапускается — отказ с кодом, группы не тронуты', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    t.conveyor.cancel(PARENT);
    const before = structuredClone(t.records.get(PARENT));

    await expect(t.conveyor.relaunch(PARENT, 'C:/repo', () => undefined)).rejects.toMatchObject({
      messageCode: 'split-plan-cancelled',
    });
    expect(t.records.get(PARENT)).toEqual(before);
    expect(t.launched()).toEqual([[0, 1]]);
  });

  it('новая жизнь группы не несёт доставку, MR, наблюдение и отметки прошлой', async () => {
    const t = build({ parallel: 1, groups: 2 });
    await t.begin();
    t.edit(PARENT, (record) => {
      const group = record.groups[0] as SplitPlanGroupRecord;
      Object.assign(group, {
        status: 'failed',
        deliver: true,
        deliveryMissing: ['нет MR'],
        deliveryNudges: 2,
        deliveryChecks: 3,
        blockedSince: '2026-09-25T09:00:00.000Z',
        mr: 'https://git.example.com/team/app/-/merge_requests/7',
        cleaned: { at: '2026-09-25T09:00:00.000Z', branch: 'kept' } as never,
        mrWatch: { since: '2026-09-25T09:00:00.000Z' } as never,
        acceptedAt: '2026-09-25T09:00:00.000Z',
        tickets: [] as never,
        interruptedAt: '2026-09-25T09:00:00.000Z',
        interruptResumes: 1,
        drift: { at: '2026-09-25T09:00:00.000Z' } as never,
        // Решения о плане — остаются.
        released: true,
        hold: 'нужен ответ',
        holdAnswer: 'только Chrome',
      } satisfies Partial<SplitPlanGroupRecord>);
    });
    const dropped: string[] = [];

    await t.conveyor.relaunch(PARENT, 'C:/repo', (chatId) => void dropped.push(chatId));

    expect(dropped).toEqual([`${PARENT}-chat-0`]);
    const group = t.group(0) as SplitPlanGroupRecord;
    // Своё решение «До MR» у новой жизни есть — её запуска (O2), прошлое «да» не переносится.
    expect(group.deliver).toBe(false);
    for (const key of [
      'deliveryMissing',
      'deliveryNudges',
      'deliveryChecks',
      'blockedSince',
      'mr',
      'cleaned',
      'mrWatch',
      'acceptedAt',
      'tickets',
      'interruptedAt',
      'interruptResumes',
      'drift',
    ]) {
      expect(group, key).not.toHaveProperty(key);
    }
    expect(group).toMatchObject({
      released: true,
      hold: 'нужен ответ',
      holdAnswer: 'только Chrome',
    });
  });

  it('перезапуск из подкаталога: путь настроек остаётся, копии — от верха репозитория', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const record = t.records.get(PARENT) as SplitPlanRecord;
    expect(record.projectPath).toBe('C:/repo/app');
    expect(record.copyRoot).toBeUndefined();

    await t.conveyor.relaunch(PARENT, 'C:/repo', () => undefined);

    const after = t.records.get(PARENT) as SplitPlanRecord;
    expect(after.projectPath).toBe('C:/repo/app');
    expect(copyRootOf(after)).toBe('C:/repo');
  });

  it('begin: верх репозитория помнится, только если он другой', async () => {
    const t = build();
    await t.begin(PARENT, { copyRoot: 'C:/repo' });
    await t.begin('второй', { copyRoot: 'c:\\repo\\app' });
    expect(t.records.get(PARENT)?.copyRoot).toBe('C:/repo');
    expect(t.records.get('второй')).not.toHaveProperty('copyRoot');
  });
});

describe('m5: копия не читается при проверке доставки', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('git не прочёл копию — группа закрыта сбоем с причиной сразу, место свободно', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'cc-split-nogit-'));
    dirs.push(copy);
    const scheduled: (() => void)[] = [];
    const nudges: string[] = [];
    // Та же обёртка, что в `runtime.ts`: настоящие факты git из каталога копии.
    const delivery: SplitDeliveryDeps = {
      facts: async (group, mr) => {
        const facts = await readDeliveryFacts({
          cwd: copy,
          branch: group.branch,
          ...(mr ? { mr } : {}),
        });
        return { missing: missingDelivery(facts, group.branch) };
      },
      nudge: (_group, prompt) => {
        nudges.push(prompt);
        return 'sent';
      },
      schedule: (run) => void scheduled.push(run),
    };
    const t = build({ parallel: 1, groups: 2, delivery });
    await t.begin();

    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    for (let i = 0; i < 100 && t.group(0)?.status !== 'failed'; i += 1) await t.flush();

    const view = t.conveyor.view([PARENT])?.groups[0];
    expect(view).toMatchObject({ status: 'failed', errorCode: 'split-delivery-local-failed' });
    expect(view?.error).toMatch(/^доставку не проверить: копия группы не читается \(.+\)$/);
    // Ни повторных проверок, ни напоминаний: ждать тут нечего.
    expect(scheduled).toEqual([]);
    expect(nudges).toEqual([]);
    expect(t.group(0)).not.toHaveProperty('deliveryChecks');
    // Место отдано следующей.
    expect(t.launched()).toEqual([[0], [1]]);
  }, 20_000);
});

describe('m11: лимит подписки — у каждого провайдера свой', () => {
  it('лимит Claude не держит очередь плана чужого CLI', async () => {
    const t = build({ parallel: 1 });
    await t.begin(PARENT);
    await t.begin(FOREIGN);
    t.conveyor.onChainEnded(t.link(0, PARENT), limitOutcome(START + 60 * 60_000));
    await t.flush();

    t.conveyor.onChainEnded(t.link(0, FOREIGN), { status: 'done' });
    await t.flush();

    expect(t.launched(FOREIGN)).toEqual([[0], [1]]);
    expect(t.launched(PARENT)).toEqual([[0]]);
    expect(t.conveyor.view([FOREIGN])?.limitUntil).toBeUndefined();
    expect(t.conveyor.view([PARENT])?.limitUntil).toBe(new Date(START + 60 * 60_000).toISOString());
  });

  it('сброс раньше у одного провайдера — он продолжается сразу, другой ждёт своего срока', async () => {
    const t = build({ parallel: 2 });
    await t.begin(PARENT);
    await t.begin(FOREIGN);
    t.conveyor.onChainEnded(t.link(0, PARENT), limitOutcome(START + 60 * 60_000));
    t.conveyor.onChainEnded(t.link(0, FOREIGN), limitOutcome(START + 10 * 60_000));
    await t.flush();

    await t.advance(10 * 60_000);
    expect(t.resumed).toEqual([{ parent: FOREIGN, index: 0 }]);
    expect(t.group(0, PARENT)).toMatchObject({ status: 'awaiting', waitingFor: 'limit' });

    await t.advance(50 * 60_000);
    expect(t.resumed).toEqual([
      { parent: FOREIGN, index: 0 },
      { parent: PARENT, index: 0 },
    ]);
  });
});

describe('m12: отложенное продолжение доставленной группы — настоящий итог', () => {
  it('место появилось, а сессия слово не приняла — «refused», а не «sent»', async () => {
    const t = build({ parallel: 1, groups: 2, refuse: true });
    await t.begin();
    t.edit(PARENT, (record) => {
      const group = record.groups[0] as SplitPlanGroupRecord;
      group.deliver = true;
    });
    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    expect(t.group(1)?.status).toBe('started');

    // Потолок полон — слово отложено.
    expect(t.conveyor.resumeDelivered(PARENT, 0, 'ветки ревьюера')).toBe('queued');
    expect(t.group(0)?.parked).toBeDefined();

    // Место освободилось мимо конца цепочки (запись поправили снаружи), и второе
    // слово наблюдателя отпускает отложенное — сессия его не принимает.
    t.edit(PARENT, (record) => {
      (record.groups[1] as SplitPlanGroupRecord).status = 'done';
    });
    expect(t.conveyor.resumeDelivered(PARENT, 0, 'упал конвейер')).toBe('refused');
    expect(t.group(0)?.parked).toBeUndefined();
  });
});
