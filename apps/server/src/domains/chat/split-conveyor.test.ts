import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import type { SplitGroupContext } from './ChatSplit.ts';
import {
  DELIVERY_BLOCKED_PROBE_MS,
  DELIVERY_BLOCKED_PROBES,
  DELIVERY_RECHECK_MS,
  MAX_DELIVERY_NUDGES,
  MAX_INTERRUPT_RESUMES,
  SplitConveyor,
  trackerKeys,
  type ChainOutcome,
  type DeliveryVerdict,
  type SplitConveyorDeps,
  type SplitDeliveryDeps,
} from './split-conveyor.ts';

/** Первая строка сообщений панели в чат группы 0 (журнал 98). */
const IDENTITY = 'Ветка группы: feature/login. Задачи группы: PROJ-101, PROJ-102.';

const DONE: ChainOutcome = { status: 'done' };
const FAILED: ChainOutcome = { status: 'failed' };

/**
 * Конвейер уровней (Т1): что стартует после разбора, кто ждёт кого, от какой
 * ветки отводится копия ждавшей группы и что происходит, когда разбора нет.
 * Ни git, ни реестра: запуск — колбэк, память — Map.
 */

const PROPOSAL = {
  shared: 'Общее',
  groups: [
    {
      title: 'Форма входа',
      branch: 'feature/login',
      tasks: ['PROJ-101 починить валидацию', 'PROJ-102 и UTF-8 в заголовке', 'PROJ-101 повтор'],
    },
    { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять отступ'] },
    { title: 'Тесты', branch: 'feature/tests', tasks: ['тест на форму'] },
  ],
};

function finished(text: string, ok = true): RunFinished {
  return {
    chatId: 'new-1-triage',
    projectPath: 'C:/repo',
    text,
    ok,
    startedAt: 1,
    options: { prompt: '', cwd: 'C:/repo' },
    contextTokens: 0,
  };
}

function block(json: unknown): string {
  return ['Развёл.', '```' + SPLIT_PLAN_BLOCK_LANG, JSON.stringify(json), '```'].join('\n');
}

function build(
  options: {
    triageStarts?: boolean;
    failLaunch?: number[];
    /** Своё предложение вместо трёх групп по умолчанию. */
    proposal?: typeof PROPOSAL;
    /** Сколько групп разом (настройка проекта); не задано — без ограничения. */
    parallel?: number;
    /** Группы запускаются с доставкой до MR, и конвейер проверяет её этими фактами. */
    delivery?: SplitDeliveryDeps;
    /** Продолжение оборванной группы (WP1c). */
    resume?: SplitConveyorDeps['resume'];
    /** Что запуск делает ВНУТРИ себя, до возврата: настоящее имя ветки, конец цепочки. */
    during?: (
      groups: number[],
      claimBranch: (index: number, branch: string) => void,
    ) => void | Promise<void>;
  } = {},
) {
  const records = new Map<string, SplitPlanRecord>();
  const launches: { groups: number[]; context?: SplitGroupContext }[] = [];
  /** Кого позвали сверять ветки (Т6) — по концу цепочки, а не по расписанию. */
  const overlapChecks: string[] = [];
  let tick = 0;
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => records.get(parent),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups, context, claimBranch): Promise<TaskSplitResult> => {
      launches.push({ groups, ...(context ? { context } : {}) });
      await options.during?.(groups, claimBranch);
      return {
        chats: groups.map((index) => ({
          index,
          title: record.proposal.groups[index]?.title ?? '',
          branch: record.groups[index]?.branch ?? '',
          chatId: `new-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: !(options.failLaunch ?? []).includes(index),
          prompt: '',
          ...(options.delivery ? { deliver: true } : {}),
        })),
        failures: [],
      };
    },
    startTriage: () => ({
      chatId: 'new-1-triage',
      started: options.triageStarts ?? true,
      deferred: false,
    }),
    watchOverlap: (parent) => void overlapChecks.push(parent),
    ...(options.parallel ? { parallel: () => options.parallel as number } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    log: () => undefined,
    now: () => new Date(2026, 8, 9, 12, 0, (tick += 1)),
  });
  const begin = () =>
    conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: options.proposal ?? PROPOSAL,
      request: {},
    });
  const link = (index: number): ChatLink => ({
    parentChatId: 'родитель',
    createdAt: '',
    branch: `feature/${['login', 'header', 'tests', 'docs'][index]}`,
    stage: 'work',
  });
  const wait = () => new Promise((done) => setTimeout(done, 5));
  return { conveyor, records, launches, overlapChecks, begin, link, wait };
}

/** Разбор применён: третья группа ждёт первых двух и стоит на вопросе человеку. */
async function triaged(options: Parameters<typeof build>[0] = {}) {
  const built = build(options);
  await built.begin();
  built.conveyor.onTriageFinished(
    finished(
      block({
        groups: [{ index: 3, after: [1, 2], hold: 'какие браузеры?' }],
        order: [1, 2, 3],
      }),
    ),
    ['new-1-triage'],
  );
  await built.wait();
  return built;
}

describe('SplitConveyor.begin', () => {
  it('разбор стартовал — копий нет, ответ несёт чат разбора', async () => {
    const { begin, launches, records } = build();

    const { result } = await begin();

    expect(result.chats).toEqual([]);
    expect(result.triage).toMatchObject({ chatId: 'new-1-triage', started: true });
    expect(launches).toEqual([]);
    expect(records.get('родитель')?.groups.every((group) => group.status === 'pending')).toBe(true);
  });

  it('разбор не стартовал — уровень не блокирует: группы стартуют разом', async () => {
    const { begin, launches, records } = build({ triageStarts: false });

    const { result } = await begin();

    expect(launches).toEqual([{ groups: [0, 1, 2] }]);
    expect(result.chats).toHaveLength(3);
    expect(records.get('родитель')?.triage?.received).toBe(false);
  });
});

describe('SplitConveyor.onTriageFinished', () => {
  it('применяет блок: без ожиданий — сразу, after — ждут, hold — стоят', async () => {
    const { conveyor, begin, launches, records, wait } = build();
    await begin();

    const event = conveyor.onTriageFinished(
      finished(
        block({
          // Номера в блоке — с единицы, как модель и отвечает.
          groups: [
            { index: 2, owns: ['src/header.tsx'], notes: 'api.ts твой' },
            { index: 3, after: [2, 'Форма входа'], hold: 'какие браузеры?' },
          ],
          order: [2, 1, 3],
        }),
      ),
      ['new-1-triage'],
    );
    await wait();

    expect(event).toMatchObject({ kind: 'notice', code: 'triageApplied' });
    expect((event as { text: string }).text).toContain('стартуют сразу: 2');
    expect((event as { text: string }).text).toContain('ждут ответа человека: 1');
    expect(launches).toEqual([{ groups: [0, 1] }]);
    const record = records.get('родитель') as SplitPlanRecord;
    expect(record.order).toEqual([1, 0, 2]);
    expect(record.groups.map((group) => group.status)).toEqual(['started', 'started', 'held']);
    expect(record.groups[2]).toMatchObject({ after: [1, 0], hold: 'какие браузеры?' });
    // Границы разбора легли в предложение — по нему заводится план группы.
    expect(record.proposal.groups[1]).toMatchObject({
      owns: ['src/header.tsx'],
      notes: 'api.ts твой',
    });
  });

  it('блока нет — группы стартуют как предложено, лента говорит «не получен»', async () => {
    const { conveyor, begin, launches, wait } = build();
    await begin();

    const event = conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await wait();

    expect(event).toMatchObject({ kind: 'notice', code: 'triageMissing' });
    expect(launches).toEqual([{ groups: [0, 1, 2] }]);
  });

  it('упавший разбор тоже не блокирует', async () => {
    const { conveyor, begin, launches, wait } = build();
    await begin();

    const event = conveyor.onTriageFinished(finished('', false), ['new-1-triage']);
    await wait();

    expect((event as { text: string }).text).toContain('прогон не завершился');
    expect(launches).toEqual([{ groups: [0, 1, 2] }]);
  });

  it('чужой чат и повторный конец разбора ничего не делают', async () => {
    const { conveyor, begin, launches, wait } = build();
    await begin();
    conveyor.onTriageFinished(finished('нет блока'), ['new-1-triage']);
    await wait();

    expect(conveyor.onTriageFinished(finished('нет блока'), ['new-1-triage'])).toBeUndefined();
    expect(conveyor.onTriageFinished(finished('нет блока'), ['кто-то'])).toBeUndefined();
    expect(launches).toHaveLength(1);
  });
});

describe('SplitConveyor: ожидания и ответ человека', () => {
  it('ждавшая группа стартует, когда кончились ВСЕ предшественники, от ветки последнего по порядку', async () => {
    const { conveyor, launches, link, records, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'только Chrome');
    expect(records.get('родитель')?.groups[2]?.status).toBe('waiting');

    conveyor.onChainEnded(link(1), DONE);
    await wait();
    expect(launches).toHaveLength(1);

    conveyor.onChainEnded(link(0), FAILED);
    await wait();

    expect(launches).toHaveLength(2);
    const context = launches[1]?.context as SplitGroupContext;
    expect(launches[1]?.groups).toEqual([2]);
    // База — ветка последнего по ПОРЯДКУ РАЗБОРА (2-я группа), не последнего закончившего.
    expect(context.base).toBe('feature/header');
    expect(context.predecessors).toEqual([
      { title: 'Форма входа', branch: 'feature/login', failed: true },
      { title: 'Шапка', branch: 'feature/header' },
    ]);
    expect(context.holdAnswer).toEqual({ question: 'какие браузеры?', answer: 'только Chrome' });
    const record = records.get('родитель') as SplitPlanRecord;
    expect(record.groups.map((group) => group.status)).toEqual(['failed', 'done', 'started']);
    expect(record.groups[2]?.base).toBe('feature/header');
  });

  it('без ответа человека группа стоит даже после предшественников', async () => {
    const { conveyor, launches, link, records, wait } = await triaged();

    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(1), DONE);
    await wait();

    expect(launches).toHaveLength(1);
    expect(records.get('родитель')?.groups[2]?.status).toBe('held');

    const result = await conveyor.answerHold('родитель', 2, 'Chrome');
    expect(result.chats.map((chat) => chat.index)).toEqual([2]);
  });

  it('второй ответ на тот же вопрос — отказ', async () => {
    const { conveyor } = await triaged();
    await conveyor.answerHold('родитель', 2, 'Chrome');

    await expect(conveyor.answerHold('родитель', 2, 'Firefox')).rejects.toThrow('не ждёт ответа');
    await expect(conveyor.answerHold('нет', 0, 'x')).rejects.toThrow();
  });

  it('конец цепочки чужой ветки или повторный конец ничего не меняют', async () => {
    const { conveyor, link, records, wait } = await triaged();

    conveyor.onChainEnded({ ...link(0), branch: 'other' }, DONE);
    conveyor.onChainEnded({ ...link(0), parentChatId: 'кто-то' }, DONE);
    await wait();
    expect(records.get('родитель')?.groups[0]?.status).toBe('started');

    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(0), FAILED);
    await wait();
    expect(records.get('родитель')?.groups[0]?.status).toBe('done');
  });

  it('вопрос человеку группу не закрывает и ждавших не отпускает; новый прогон — снова «работает» (Д3)', async () => {
    const { conveyor, launches, link, records, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'Chrome');
    conveyor.onChainEnded(link(1), DONE);
    conveyor.onChainEnded(link(0), {
      status: 'awaiting',
      waitingFor: 'question',
      tail: 'Какой браузер?',
    });
    await wait();

    // Третья ждёт ОБЕИХ: «ждёт ответа» — не конец, от недоделанной ветки не стартуют.
    expect(launches).toHaveLength(1);
    expect(conveyor.view(['родитель'])?.groups[0]).toMatchObject({
      status: 'awaiting',
      waitingFor: 'question',
      tail: 'Какой браузер?',
    });

    conveyor.onChainResumed(link(0));
    const resumed = records.get('родитель')?.groups[0];
    expect(resumed?.status).toBe('started');
    expect(resumed?.waitingFor).toBeUndefined();

    conveyor.onChainEnded(link(0), { status: 'done', result: { kind: 'changed' } });
    await wait();
    expect(launches).toHaveLength(2);
    expect(conveyor.view(['родитель'])?.groups[0]?.result).toEqual({ kind: 'changed' });
  });

  it('чат группы — тот, где идёт её звено, а не первый (план): туда и ведёт слово родителя', async () => {
    const { conveyor, link } = await triaged();
    const planChat = conveyor.view(['родитель'])?.groups[0]?.chatId;

    conveyor.onChainResumed(link(0), 'чат-работы');

    expect(planChat).toBeDefined();
    expect(conveyor.view(['родитель'])?.groups[0]?.chatId).toBe('чат-работы');
  });

  it('чат плана возвращает группу в работу только ответом на свой вопрос', async () => {
    const { conveyor, link, records } = await triaged();
    const plan: ChatLink = { ...link(0), stage: 'plan' };

    // План спросил — группа ждёт; ответ человека в чат плана — снова работа.
    conveyor.onChainEnded(plan, { status: 'awaiting', waitingFor: 'question' });
    conveyor.onChainResumed(plan, 'чат-плана');
    expect(records.get('родитель')?.groups[0]).toMatchObject({
      status: 'started',
      chatId: 'чат-плана',
    });

    // План отработан, группа закрыта: сообщение в старый чат плана её не трогает.
    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainResumed({ ...plan, plannedAt: '2026-09-25T00:00:00.000Z' }, 'чат-плана');
    expect(records.get('родитель')?.groups[0]?.status).toBe('done');
  });

  it('закрытую группу снова открывает только новый прогон', async () => {
    const { conveyor, link, records } = await triaged();
    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question' });
    expect(records.get('родитель')?.groups[0]?.status).toBe('done');

    conveyor.onChainResumed(link(0));
    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question' });
    expect(records.get('родитель')?.groups[0]?.status).toBe('awaiting');
  });

  it('группа находится по номеру из связи, даже когда ветка копии другая (Д12)', async () => {
    const { conveyor, link, records } = await triaged();

    conveyor.onChainEnded({ ...link(0), branch: 'feature/login-mr', groupIndex: 0 }, DONE);

    expect(records.get('родитель')?.groups[0]?.status).toBe('done');
  });

  it('конец цепочки зовёт сверку веток — по разу на каждый настоящий конец', async () => {
    const { conveyor, link, overlapChecks, wait } = await triaged();

    // Чужая ветка и чужой родитель концом ЭТОГО разделения не считаются.
    conveyor.onChainEnded({ ...link(0), branch: 'other' }, DONE);
    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(1), FAILED);
    // Повторный конец той же ветки: группа уже `done`, сверять нечего.
    conveyor.onChainEnded(link(0), DONE);
    await wait();

    expect(overlapChecks).toEqual(['родитель', 'родитель']);
  });

  it('пульт получает запись по любому ключу дерева', async () => {
    const { conveyor } = await triaged();

    const view = conveyor.view(['чужой', 'родитель']);
    expect(view?.triageChatId).toBe('new-1-triage');
    expect(view?.triage?.received).toBe(true);
    expect(view?.groups.map((group) => group.status)).toEqual(['started', 'started', 'held']);
    expect(view?.groups[2]?.hold).toBe('какие браузеры?');
    // Вопрос писал АГЕНТ — кода у него нет: панель его не сочиняла, и переводить
    // нечего. Код рядом с чужим текстом означал бы, что панель покажет вместо
    // него свою фразу.
    expect(view?.groups[2]).not.toHaveProperty('holdCode');
    expect(conveyor.view(['никто'])).toBeUndefined();
  });

  it('не запустившийся прогон группы — failed с причиной, остальные идут', async () => {
    const { records } = await triaged({ failLaunch: [0] });

    const record = records.get('родитель') as SplitPlanRecord;
    expect(record.groups[0]).toMatchObject({ status: 'failed', error: 'прогон не запустился' });
    expect(record.groups[1]?.status).toBe('started');
  });
});

describe('SplitConveyor: имя ветки и ручное освобождение', () => {
  it('настоящее имя ветки уезжает в запись ДО старта — цепочка, кончившаяся внутри запуска, находит свою группу', async () => {
    let claimed = false;
    const built = build({
      during: (groups, claimBranch) => {
        if (!groups.includes(0) || claimed) return;
        claimed = true;
        // git выдал занятому имени суффикс: в записи стоит `feature/login`,
        // в репозитории — `feature/login-2`, и связь несёт второе.
        claimBranch(0, 'feature/login-2');
        // Цепочка кончилась раньше, чем вернулась вся порция (чужой CLI).
        built.conveyor.onChainEnded({ ...built.link(0), branch: 'feature/login-2' }, DONE);
      },
    });
    await built.begin();
    built.conveyor.onTriageFinished(
      finished(block({ groups: [{ index: 2, after: [1] }], order: [1, 2, 3] })),
      ['new-1-triage'],
    );
    await built.wait();

    // Ждавшая группа поехала: без настоящего имени она стояла бы вечно.
    expect(built.launches.map((item) => item.groups)).toEqual([[0, 2], [1]]);
    const record = built.records.get('родитель') as SplitPlanRecord;
    expect(record.groups[0]?.branch).toBe('feature/login-2');
  });

  it('отпущенная руками группа стартует от ветки предшественника и знает, что тот не доработал', async () => {
    const { conveyor, launches, records, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'только Chrome');
    expect(records.get('родитель')?.groups[2]?.status).toBe('waiting');

    const result = await conveyor.release('родитель', 2);
    await wait();

    expect(result.chats.map((chat) => chat.index)).toEqual([2]);
    expect(launches).toHaveLength(2);
    const context = launches[1]?.context as SplitGroupContext;
    expect(context.base).toBe('feature/header');
    expect(context.predecessors).toEqual([
      { title: 'Форма входа', branch: 'feature/login', unfinished: true },
      { title: 'Шапка', branch: 'feature/header', unfinished: true },
    ]);
    expect(records.get('родитель')?.groups[2]).toMatchObject({ released: true, status: 'started' });
  });

  it('отпускать нечего: группа не ждёт предшественников', async () => {
    const { conveyor } = await triaged();

    // Стоит на вопросе человека — у этого своя дверь (`answerHold`).
    await expect(conveyor.release('родитель', 2)).rejects.toThrow('не ждёт предшественников');
    // Уже работает.
    await expect(conveyor.release('родитель', 0)).rejects.toThrow('не ждёт предшественников');
    await expect(conveyor.release('нет', 0)).rejects.toThrow();
  });

  it('заметка предшественника несёт задетые им файлы — с потолком и «и ещё N»', async () => {
    const { conveyor, launches, link, records, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'только Chrome');
    const record = records.get('родитель') as SplitPlanRecord;
    const names = Array.from({ length: 20 }, (_, i) => `src/a${i}.ts`);
    record.overlap = {
      at: '2026-09-18T10:00:00.000Z',
      files: [],
      mergeOrder: [0, 1, 2],
      counted: [
        { index: 0, files: 25, names },
        { index: 1, files: 2, names: ['src/header.tsx', 'src/api.ts'] },
      ],
      unread: [],
      noticed: [],
    };

    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(1), DONE);
    await wait();

    const context = launches[1]?.context as SplitGroupContext;
    expect(context.predecessors?.[0]).toMatchObject({ files: names, filesTotal: 25 });
    expect(context.predecessors?.[1]).toMatchObject({
      files: ['src/header.tsx', 'src/api.ts'],
      filesTotal: 2,
    });
  });

  it('сверка ещё не считалась — заметки живут без файлов, запуск не срывается', async () => {
    const { conveyor, launches, link, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'только Chrome');

    conveyor.onChainEnded(link(0), DONE);
    conveyor.onChainEnded(link(1), DONE);
    await wait();

    const context = launches[1]?.context as SplitGroupContext;
    expect(context.predecessors?.[0]).not.toHaveProperty('files');
    expect(context.predecessors?.[0]).not.toHaveProperty('filesTotal');
  });
});

// Выгрузка из трекера — это и 20 групп; разом они съели бы окно подписки за час.
describe('SplitConveyor: сколько групп разом', () => {
  it('сверх настройки группы ждут в очереди и стартуют по одной, как освобождается место', async () => {
    const { conveyor, begin, launches, records, link, wait } = build({ parallel: 1 });
    await begin();
    conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await wait();

    expect(launches).toEqual([{ groups: [0] }]);
    expect(records.get('родитель')?.groups.map((group) => group.status)).toEqual([
      'started',
      'pending',
      'pending',
    ]);

    conveyor.onChainEnded(link(0), DONE);
    await wait();
    expect(launches.map((item) => item.groups)).toEqual([[0], [1]]);

    // Вопрос человеку группу не закрывает, и место она держит (M7): ответ
    // продолжит её в этом же месте, а не сверх потолка.
    conveyor.onChainEnded(link(1), { status: 'awaiting', waitingFor: 'question' });
    await wait();
    expect(launches.map((item) => item.groups)).toEqual([[0], [1]]);

    conveyor.onChainEnded(link(1), DONE);
    await wait();
    expect(launches.map((item) => item.groups)).toEqual([[0], [1], [2]]);
  });

  it('очередь идёт в порядке разбора, а не в порядке предложения', async () => {
    const { conveyor, begin, launches, records, wait } = build({ parallel: 2 });
    await begin();
    conveyor.onTriageFinished(
      finished(block({ groups: [{ index: 3, notes: 'первой' }], order: [3, 1, 2] })),
      ['new-1-triage'],
    );
    await wait();

    expect(records.get('родитель')?.order).toEqual([2, 0, 1]);
    expect(launches).toEqual([{ groups: [0, 2] }]);
  });

  it('ссылка на MR группы доезжает в пульт и не стирается следующим ходом без неё', async () => {
    const { conveyor, begin, link, wait } = build({ parallel: 1 });
    await begin();
    conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await wait();
    const mr = 'https://git.example.com/team/app/-/merge_requests/815';

    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question', mr });
    conveyor.onChainResumed(link(0));
    conveyor.onChainEnded(link(0), DONE);

    expect(conveyor.view(['родитель'])?.groups[0]?.mr).toBe(mr);
  });

  // Журнал 25: поднятый потолок ничего не менял, пока какая-то группа не
  // доработает, — очередь двигал только конец цепочки.
  it('потолок подняли — очередь добирает места сразу, без конца чьей-то цепочки', async () => {
    const options = { parallel: 1 };
    const { conveyor, begin, launches, wait } = build(options);
    await begin();
    conveyor.kickProject('C:/repo');
    await wait();
    // До разбора очередь не трогаем: группы ещё не расставлены.
    expect(launches).toEqual([]);

    conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await wait();
    expect(launches).toEqual([{ groups: [0] }]);

    options.parallel = 3;
    conveyor.kickProject('C:/other');
    await wait();
    expect(launches).toEqual([{ groups: [0] }]);

    conveyor.kickProject('C:/repo/');
    await wait();
    expect(launches).toEqual([{ groups: [0] }, { groups: [1, 2] }]);

    // Мест нет, ждущих нет — повторный толчок ничего не заводит.
    conveyor.kickProject('C:/repo');
    await wait();
    expect(launches).toHaveLength(2);
  });

  it('без настройки — как раньше: все готовые разом', async () => {
    const { conveyor, begin, launches, wait } = build();
    await begin();
    conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await wait();

    expect(launches).toEqual([{ groups: [0, 1, 2] }]);
  });
});

/**
 * Доставка по фактам (живой прогон 24.09: «готово» у групп без push, без MR и
 * со ссылкой на чужой MR). Факты git — колбэк: сам git проверен в
 * `delivery-facts.test.ts`, здесь — что конвейер делает с их ответом.
 */
describe('SplitConveyor: доставка по фактам git', () => {
  const MR = 'https://git.example.com/team/app/-/merge_requests/7';

  function deliveryHarness(answers: DeliveryVerdict[], nudgeResult: 'sent' | 'refused' = 'sent') {
    const timers: { run: () => void; ms: number }[] = [];
    const nudges: { index: number; prompt: string }[] = [];
    const asked: (string | undefined)[] = [];
    const delivery: SplitDeliveryDeps = {
      facts: async (_group, hint) => {
        asked.push(hint);
        return answers.shift() ?? { missing: [] };
      },
      nudge: (group, prompt) => {
        nudges.push({ index: group.index, prompt });
        return nudgeResult;
      },
      schedule: (run, ms) => void timers.push({ run, ms }),
    };
    /** Выполнить отложенные сверки по одной и дать промисам осесть. */
    const fire = async (): Promise<void> => {
      const next = timers.shift();
      next?.run();
      await new Promise((done) => setTimeout(done, 5));
    };
    return { delivery, timers, nudges, asked, fire };
  }

  async function started(delivery: SplitDeliveryDeps, parallel?: number) {
    const built = build({ delivery, ...(parallel ? { parallel } : {}) });
    await built.begin();
    built.conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await built.wait();
    return built;
  }

  it('«готово» без проверки не ставится: ждёт фактов, место держит, потом done с проверенным MR', async () => {
    const h = deliveryHarness([{ missing: [], mr: MR }]);
    const { conveyor, records, launches, link } = await started(h.delivery, 1);
    const foreign = 'https://git.example.com/team/app/-/merge_requests/5';

    conveyor.onChainEnded(link(0), { status: 'done', mr: foreign });

    const group = () => records.get('родитель')?.groups[0];
    expect(group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
    // Пока проверка идёт, следующая группа не стартует: место занято.
    expect(launches.map((item) => item.groups)).toEqual([[0]]);

    await new Promise((done) => setTimeout(done, 5));
    expect(h.asked).toEqual([foreign]);
    expect(group()).toMatchObject({ status: 'done', mr: MR });
    expect(launches.map((item) => item.groups)).toEqual([[0], [1]]);
    // Решение о доставке — в пульт: шапка чата группы показывает его (O2).
    expect(conveyor.view(['родитель'])?.groups[0]?.deliver).toBe(true);
  });

  it('не хватает — одна повторная сверка, затем напоминание группе со списком; ответ — снова «работает»', async () => {
    const missing = ['ветка feature/login не отправлена на удалённый'];
    const h = deliveryHarness([{ missing }, { missing }]);
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    // Первая сверка — только таймер повтора, напоминания ещё нет.
    expect(h.nudges).toEqual([]);
    expect(h.timers.map((timer) => timer.ms)).toHaveLength(1);

    await h.fire();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).toContain(missing[0]);
    // Первая строка — ветка и ключи задач (журнал 98): без ключа сторож git не
    // пускает правку истории своей ветки.
    expect(h.nudges[0]?.prompt.startsWith(`${IDENTITY}\n\n`)).toBe(true);
    expect(records.get('родитель')?.groups[0]).toMatchObject({
      status: 'awaiting',
      waitingFor: 'delivery',
      deliveryNudges: 1,
      deliveryMissing: missing,
    });
    expect(conveyor.view(['родитель'])?.groups[0]).toMatchObject({
      deliveryMissing: missing,
      deliveryNudges: 1,
    });

    conveyor.onChainResumed(link(0), 'new-0');
    expect(records.get('родитель')?.groups[0]?.status).toBe('started');
  });

  it(`после ${MAX_DELIVERY_NUDGES} напоминаний — failed с причиной, ждавших отпускает`, async () => {
    const missing = ['нет MR, чья голова — HEAD копии'];
    const answers = Array.from({ length: 2 * (MAX_DELIVERY_NUDGES + 1) }, () => ({ missing }));
    const h = deliveryHarness(answers);
    const { conveyor, records, link, wait } = await started(h.delivery);

    for (let round = 0; round <= MAX_DELIVERY_NUDGES; round += 1) {
      conveyor.onChainEnded(link(0), { status: 'done' });
      await wait();
      await h.fire();
      if (round < MAX_DELIVERY_NUDGES) conveyor.onChainResumed(link(0), 'new-0');
    }

    expect(h.nudges).toHaveLength(MAX_DELIVERY_NUDGES);
    const group = records.get('родитель')?.groups[0];
    expect(group?.status).toBe('failed');
    expect(group?.error).toContain('доставка не доведена');
    expect(group?.error).toContain(missing[0]);
  });

  it('напоминание не ушло (чат не продолжить) — сразу failed, а не вечное ожидание', async () => {
    const missing = ['незакоммиченные правки: a.ts'];
    const h = deliveryHarness([{ missing }, { missing }], 'refused');
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    await h.fire();

    expect(records.get('родитель')?.groups[0]?.status).toBe('failed');
  });

  it('удалённый не отвечает — проверки с паузами, потом «заблокирована сервисом», потом failed', async () => {
    const down = { missing: [], unreachable: 'Could not resolve host' };
    const total = DELIVERY_RECHECK_MS.length + DELIVERY_BLOCKED_PROBES + 1;
    const h = deliveryHarness(Array.from({ length: total }, () => down));
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    for (const ms of DELIVERY_RECHECK_MS) {
      expect(records.get('родитель')?.groups[0]).toMatchObject({ waitingFor: 'delivery' });
      expect(records.get('родитель')?.groups[0]?.blockedSince).toBeUndefined();
      expect(h.timers[0]?.ms).toBe(ms);
      await h.fire();
    }
    // Короткие попытки кончились — группа не сдаётся, а ждёт сервис (журнал 101).
    for (let probe = 0; probe < DELIVERY_BLOCKED_PROBES; probe += 1) {
      const group = records.get('родитель')?.groups[0];
      expect(group).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
      expect(group?.blockedSince).toBeDefined();
      expect(group?.deliveryMissing?.[0]).toContain('удалённый недоступен');
      expect(h.timers[0]?.ms).toBe(DELIVERY_BLOCKED_PROBE_MS);
      await h.fire();
    }

    const group = records.get('родитель')?.groups[0];
    expect(group?.status).toBe('failed');
    expect(group?.error).toContain('Could not resolve host');
    expect(group?.blockedSince).toBeUndefined();
    expect(h.timers).toEqual([]);
    expect(h.nudges).toEqual([]);
  });

  // T7: агент назвал чужой MR («зависит от !789») — в запись группы попадает
  // только MR, найденный проверкой по голове её ветки.
  it('MR из текста у группы с доставкой не записывается; записывается проверенный', async () => {
    const foreign = 'https://git.example.com/team/app/-/merge_requests/789';
    let release: (verdict: DeliveryVerdict) => void = () => undefined;
    const h = deliveryHarness([]);
    h.delivery.facts = (_group, hint) => {
      h.asked.push(hint);
      return new Promise((done) => (release = done));
    };
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question', mr: foreign });
    expect(records.get('родитель')?.groups[0]?.mr).toBeUndefined();

    conveyor.onChainResumed(link(0), 'new-0');
    conveyor.onChainEnded(link(0), { status: 'done', mr: foreign });
    expect(records.get('родитель')?.groups[0]?.mr).toBeUndefined();
    expect(h.asked).toEqual([foreign]);

    release({ missing: [], mr: MR });
    await wait();
    expect(records.get('родитель')?.groups[0]).toMatchObject({ status: 'done', mr: MR });
  });

  it('человек продолжил заблокированную группу — следующий ход считает попытки заново', async () => {
    const down = { missing: [], unreachable: 'HTTP 502' };
    const h = deliveryHarness(Array.from({ length: 20 }, () => down));
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    for (let step = 0; step < DELIVERY_RECHECK_MS.length; step += 1) await h.fire();
    expect(records.get('родитель')?.groups[0]?.blockedSince).toBeDefined();

    conveyor.onChainResumed(link(0), 'new-0');
    expect(records.get('родитель')?.groups[0]?.blockedSince).toBeUndefined();
    h.timers.length = 0;
    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    expect(h.timers[0]?.ms).toBe(DELIVERY_RECHECK_MS[0]);
  });

  // Журнал 101: GitLab отдавал 502, группа не отправила ветку и кончила ход.
  // Сервис ожил — панель сама доводит доставку напоминанием, а не ждёт человека.
  it('сервис ожил после блокировки — напоминание группе, отметка блокировки снята', async () => {
    const down = { missing: [], unreachable: 'HTTP 502' };
    const missing = ['ветка не отправлена'];
    const h = deliveryHarness([
      ...Array.from({ length: DELIVERY_RECHECK_MS.length + 2 }, () => down),
      { missing },
      { missing },
    ]);
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    await wait();
    for (let step = 0; step < DELIVERY_RECHECK_MS.length + 1; step += 1) await h.fire();
    expect(records.get('родитель')?.groups[0]?.blockedSince).toBeDefined();

    await h.fire();
    expect(records.get('родитель')?.groups[0]?.blockedSince).toBeUndefined();
    await h.fire();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.prompt).toContain(missing[0]);
    expect(records.get('родитель')?.groups[0]?.deliveryChecks).toBeUndefined();
  });

  it('человек продолжил группу, пока шла проверка, — её ответ группу не трогает', async () => {
    let answer: (verdict: DeliveryVerdict) => void = () => undefined;
    const h = deliveryHarness([]);
    h.delivery.facts = () => new Promise((done) => (answer = done));
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'done' });
    conveyor.onChainResumed(link(0), 'new-0');
    answer({ missing: [], mr: MR });
    await wait();

    expect(records.get('родитель')?.groups[0]?.status).toBe('started');
  });

  it('проверка, оборванная перезапуском панели, идёт заново', async () => {
    const h = deliveryHarness([{ missing: [], mr: MR }]);
    h.delivery.facts = () => new Promise(() => undefined);
    const { conveyor, records, link, wait } = await started(h.delivery);
    conveyor.onChainEnded(link(0), { status: 'done' });

    h.delivery.facts = async () => ({ missing: [], mr: MR });
    conveyor.recoverDeliveryChecks();
    await wait();

    expect(records.get('родитель')?.groups[0]).toMatchObject({ status: 'done', mr: MR });
  });

  it('группа на проверке доставки держит место: очередь не обгоняет её напоминание', async () => {
    const h = deliveryHarness([]);
    h.delivery.facts = () => new Promise(() => undefined);
    const proposal = {
      ...PROPOSAL,
      groups: [...PROPOSAL.groups, { title: 'Доки', branch: 'feature/docs', tasks: ['описать'] }],
    };
    const built = build({ delivery: h.delivery, parallel: 2, proposal });
    await built.begin();
    built.conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await built.wait();
    expect(built.launches.map((item) => item.groups)).toEqual([[0, 1]]);

    built.conveyor.onChainEnded(built.link(0), { status: 'done' });
    built.conveyor.onChainEnded(built.link(1), FAILED);
    await built.wait();

    // Место освободила только упавшая группа: стартует одна, а не две.
    expect(built.launches.map((item) => item.groups)).toEqual([[0, 1], [2]]);
  });

  it('вопрос и сбой проверку не заводят — только «готово»', async () => {
    const h = deliveryHarness([]);
    const { conveyor, records, link, wait } = await started(h.delivery);

    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question' });
    conveyor.onChainEnded(link(1), FAILED);
    await wait();

    expect(h.asked).toEqual([]);
    expect(records.get('родитель')?.groups.map((group) => group.status)).toEqual([
      'awaiting',
      'failed',
      'started',
    ]);
  });
});

describe('SplitConveyor: обрыв процесса группы (WP1c)', () => {
  /**
   * Продолжение идёт настоящим каналом конвейера: `resume` отвечает, ушло ли
   * слово, а ушедшее — это старт прогона, который реестр отмечает
   * `onChainResumed` (как `setStartListener` в runtime).
   */
  function resumeHarness(result: 'sent' | 'refused' = 'sent') {
    const h = {
      result,
      calls: [] as { index: number; prompt: string; statusAtCall?: string }[],
      onStart: undefined as undefined | ((index: number) => void),
      records: undefined as undefined | Map<string, SplitPlanRecord>,
    };
    const resume: NonNullable<SplitConveyorDeps['resume']> = (group, prompt) => {
      const stored = h.records?.get('родитель')?.groups[group.index];
      h.calls.push({
        index: group.index,
        prompt,
        ...(stored ? { statusAtCall: `${stored.status}/${stored.waitingFor ?? ''}` } : {}),
      });
      if (h.result === 'refused') return 'refused';
      h.onStart?.(group.index);
      return 'sent';
    };
    return { h, resume };
  }

  async function running(result: 'sent' | 'refused' = 'sent', parallel?: number) {
    const { h, resume } = resumeHarness(result);
    const built = build({ resume, ...(parallel ? { parallel } : {}) });
    h.records = built.records;
    h.onStart = (index) => built.conveyor.onChainResumed(built.link(index), `new-${index}`);
    await built.begin();
    built.conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await built.wait();
    return { ...built, h };
  }

  it('оборванная группа «прервана» и продолжается своей сессией с восстановлением состояния; место держит', async () => {
    const { conveyor, records, launches, link, wait, h } = await running('sent', 1);
    expect(launches.map((item) => item.groups)).toEqual([[0]]);

    conveyor.onChainInterrupted(link(0));
    await wait();

    expect(h.calls).toHaveLength(1);
    // К моменту продолжения запись уже говорит правду: прервана и ждёт.
    expect(h.calls[0]?.statusAtCall).toBe('awaiting/interrupted');
    expect(h.calls[0]?.prompt.startsWith(`${IDENTITY}\n\n`)).toBe(true);
    expect(h.calls[0]?.prompt).toContain('git status');
    expect(records.get('родитель')?.groups[0]).toMatchObject({
      status: 'started',
      interruptResumes: 1,
    });
    // Обрыв — не конец: очередь не сдвинулась, ждавшие не отпущены.
    expect(launches.map((item) => item.groups)).toEqual([[0]]);
  });

  it('продолжение не ушло — группа ждёт кнопки, место держит, счёт не тратится', async () => {
    const { conveyor, records, launches, link, wait, h } = await running('refused', 1);

    conveyor.onChainInterrupted(link(0));
    await wait();

    expect(h.calls).toHaveLength(1);
    const group = records.get('родитель')?.groups[0];
    expect(group).toMatchObject({ status: 'awaiting', waitingFor: 'interrupted' });
    expect(group?.interruptResumes).toBeUndefined();
    expect(group?.interruptedAt).toBeTruthy();
    expect(launches.map((item) => item.groups)).toEqual([[0]]);
    expect(conveyor.view(['родитель'])?.groups[0]).toMatchObject({
      waitingFor: 'interrupted',
      interruptedAt: group?.interruptedAt,
    });
  });

  it(`после ${MAX_INTERRUPT_RESUMES} продолжений подряд — ждёт человека; «Продолжить» даёт попытки снова, законченный ход обнуляет счёт`, async () => {
    const { conveyor, records, link, wait, h } = await running();

    for (let round = 0; round <= MAX_INTERRUPT_RESUMES; round += 1) {
      conveyor.onChainInterrupted(link(0));
      await wait();
    }
    expect(h.calls).toHaveLength(MAX_INTERRUPT_RESUMES);
    expect(records.get('родитель')?.groups[0]).toMatchObject({
      status: 'awaiting',
      waitingFor: 'interrupted',
    });

    expect(conveyor.resumeInterrupted('родитель')).toEqual({ resumed: [0], refused: [] });
    expect(h.calls).toHaveLength(MAX_INTERRUPT_RESUMES + 1);
    expect(records.get('родитель')?.groups[0]?.status).toBe('started');

    conveyor.onChainEnded(link(0), { status: 'awaiting', waitingFor: 'question' });
    const group = records.get('родитель')?.groups[0];
    expect(group?.interruptResumes).toBeUndefined();
    expect(group?.interruptedAt).toBeUndefined();
  });

  it('прерванная группа держит место: освободившееся место очередь занимает одной группой, а не двумя', async () => {
    const { h, resume } = resumeHarness('refused');
    const proposal = {
      ...PROPOSAL,
      groups: [...PROPOSAL.groups, { title: 'Доки', branch: 'feature/docs', tasks: ['описать'] }],
    };
    const built = build({ resume, parallel: 2, proposal });
    h.records = built.records;
    await built.begin();
    built.conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await built.wait();
    expect(built.launches.map((item) => item.groups)).toEqual([[0, 1]]);

    built.conveyor.onChainInterrupted(built.link(0));
    built.conveyor.onChainEnded(built.link(1), FAILED);
    await built.wait();

    expect(built.launches.map((item) => item.groups)).toEqual([[0, 1], [2]]);
  });

  it('«Продолжить» — одна группа по номеру или все прерванные; остальные не трогает', async () => {
    const { conveyor, records, link, wait, h } = await running('refused');
    conveyor.onChainInterrupted(link(0));
    conveyor.onChainInterrupted(link(1));
    await wait();
    h.result = 'sent';
    h.calls.length = 0;

    expect(conveyor.resumeInterrupted('родитель', 1)).toEqual({ resumed: [1], refused: [] });
    expect(h.calls.map((call) => call.index)).toEqual([1]);
    expect(records.get('родитель')?.groups.map((group) => group.status)).toEqual([
      'awaiting',
      'started',
      'started',
    ]);

    expect(conveyor.resumeInterrupted('родитель')).toEqual({ resumed: [0], refused: [] });
    expect(conveyor.resumeInterrupted('чужой')).toEqual({ resumed: [], refused: [] });
  });

  it('после перезапуска: мёртвые «работает» и ждавшие повтора прерваны, живые не тронуты; второй обход ничего не повторяет', async () => {
    const { conveyor, records, link, wait, h } = await running('refused');
    conveyor.onChainEnded(link(2), { status: 'awaiting', waitingFor: 'retry', retries: 1 });
    await wait();

    const notices = conveyor.recoverInterruptedGroups((group) => group.index === 1);

    expect(records.get('родитель')?.groups.map((g) => `${g.status}/${g.waitingFor ?? ''}`)).toEqual(
      ['awaiting/interrupted', 'started/', 'awaiting/interrupted'],
    );
    expect(h.calls.map((call) => call.index)).toEqual([0, 2]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      parentChatId: 'родитель',
      event: {
        kind: 'notice',
        code: 'groupsInterrupted',
        textCode: 'split-groups-interrupted-notice',
        textParams: { groups: '«Форма входа», «Тесты»', resumed: '0' },
      },
    });

    expect(conveyor.recoverInterruptedGroups(() => false)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          textParams: expect.objectContaining({ groups: '«Шапка»' }),
        }),
      }),
    ]);
  });
});

describe('SplitConveyor.recoverInterruptedTriage', () => {
  it('разбор не пережил перезапуск — группы встают на вопрос человеку, а не навсегда', async () => {
    const { conveyor, begin, records, launches } = build();
    await begin();

    const notices = conveyor.recoverInterruptedTriage(() => false);

    const record = records.get('родитель') as SplitPlanRecord;
    // Запись разморожена: итога разбора не будет никогда, и об этом сказано.
    // `interrupted` отдельно от `received`: без него хаб подписывал бы это
    // «группы пошли как предложено», а они не пошли — они стоят на вопросе.
    expect(record.triage).toMatchObject({ received: false, interrupted: true });
    // Ничего не стартует само — дверь открыта человеку, а не агенту.
    expect(launches).toEqual([]);
    expect(record.groups.map((group) => group.status)).toEqual(['held', 'held', 'held']);
    expect(record.groups[0]?.hold).toBeTruthy();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.parentChatId).toBe('родитель');
    expect(notices[0]?.event).toMatchObject({ kind: 'notice', code: 'triageMissing' });
  });

  it('вопрос и заметка панели едут с кодом — их читают словарём, а не по-русски', async () => {
    const { conveyor, begin } = build();
    await begin();

    const notices = conveyor.recoverInterruptedTriage(() => false);

    // Заметка родителю: повод (`code`) и код самой строки — разные вещи, и
    // счёт вставших групп едет подстановкой, а не вплавлен в текст.
    expect(notices[0]?.event).toMatchObject({
      kind: 'notice',
      code: 'triageMissing',
      textCode: 'split-triage-interrupted-notice',
      textParams: { groups: 3 },
    });
    // Вопрос группы писала ПАНЕЛЬ — в пульте он с кодом, и русская строка
    // остаётся рядом запасной (её же читает чужой CLI и клиент постарше).
    const group = conveyor.view(['родитель'])?.groups[0];
    expect(group?.holdCode).toBe('split-triage-interrupted-hold');
    expect(group?.hold).toContain('Разбор оборвался');
  });

  it('разбор пережил перезапуск — запись не трогаем', async () => {
    const { conveyor, begin, records } = build();
    await begin();

    expect(conveyor.recoverInterruptedTriage((chatId) => chatId === 'new-1-triage')).toEqual([]);
    expect((records.get('родитель') as SplitPlanRecord).triage).toBeUndefined();
  });

  it('второй запуск панели ничего не повторяет', async () => {
    const { conveyor, begin } = build();
    await begin();

    expect(conveyor.recoverInterruptedTriage(() => false)).toHaveLength(1);
    expect(conveyor.recoverInterruptedTriage(() => false)).toEqual([]);
  });

  it('после разморозки ответ человека запускает группу обычной дверью', async () => {
    const { conveyor, begin, launches } = build();
    await begin();
    conveyor.recoverInterruptedTriage(() => false);

    const result = await conveyor.answerHold('родитель', 1, 'да, запускай');

    expect(result.chats.map((chat) => chat.index)).toEqual([1]);
    expect(launches).toEqual([{ groups: [1], context: { holdAnswer: expect.anything() } }]);
  });
});

// Журнал 98: сообщения панели в чат группы несут ветку и ключи задач.
describe('SplitConveyor: ветка и задачи группы', () => {
  it('ключи задач — по порядку, без повторов и без UTF-8/ISO-8601', () => {
    expect(trackerKeys('PROJ-7 и ISO-8601, UTF-8, ABC-12; снова PROJ-7, x-1, G-5')).toEqual([
      'PROJ-7',
      'ABC-12',
    ]);
  });

  it('звено за группой получает строку своей группы; чужая связь — ничего', async () => {
    const { conveyor, begin, link } = build();
    await begin();

    expect(conveyor.identityOf(link(0))).toBe(IDENTITY);
    expect(conveyor.identityOf({ ...link(0), branch: 'feature/header' })).toBe(
      'Ветка группы: feature/header.',
    );
    expect(conveyor.identityOf({ ...link(0), groupIndex: 2, branch: 'feature/login' })).toBe(
      'Ветка группы: feature/tests.',
    );
    expect(conveyor.identityOf({ ...link(0), parentChatId: 'чужой' })).toBeUndefined();
    expect(conveyor.identityOf({ ...link(0), branch: 'feature/нет' })).toBeUndefined();
  });
});

// Живой прогон 25.09 (O2, третий): план без «До MR» не писал решение вовсе, и
// шапка чата группы брала настройку проекта — «вкл», хотя группа шла без MR.
describe('решение «До MR» группы в пульте', () => {
  it('заведённая без доставки группа несёт deliver: false, не заведённая — ничего', async () => {
    const built = build({ parallel: 1 });
    await built.begin();
    built.conveyor.onTriageFinished(finished('Ничего не нашёл.'), ['new-1-triage']);
    await built.wait();

    const groups = built.conveyor.view(['родитель'])?.groups ?? [];
    expect(groups[0]?.status).toBe('started');
    expect(groups[0]?.deliver).toBe(false);
    expect(groups[1]?.deliver).toBeUndefined();
  });
});
