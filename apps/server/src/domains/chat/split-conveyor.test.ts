import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import type { SplitGroupContext } from './ChatSplit.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * Конвейер уровней (Т1): что стартует после разбора, кто ждёт кого, от какой
 * ветки отводится копия ждавшей группы и что происходит, когда разбора нет.
 * Ни git, ни реестра: запуск — колбэк, память — Map.
 */

const PROPOSAL = {
  shared: 'Общее',
  groups: [
    { title: 'Форма входа', branch: 'feature/login', tasks: ['починить валидацию'] },
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

function build(options: { triageStarts?: boolean; failLaunch?: number[] } = {}) {
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
    launch: async (record, groups, context): Promise<TaskSplitResult> => {
      launches.push({ groups, ...(context ? { context } : {}) });
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
    log: () => undefined,
    now: () => new Date(2026, 8, 9, 12, 0, (tick += 1)),
  });
  const begin = () =>
    conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
  const link = (index: number): ChatLink => ({
    parentChatId: 'родитель',
    createdAt: '',
    branch: `feature/${['login', 'header', 'tests'][index]}`,
    stage: 'work',
  });
  const wait = () => new Promise((done) => setTimeout(done, 5));
  return { conveyor, records, launches, overlapChecks, begin, link, wait };
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

  it('ждавшая группа стартует, когда кончились ВСЕ предшественники, от ветки последнего по порядку', async () => {
    const { conveyor, launches, link, records, wait } = await triaged();
    await conveyor.answerHold('родитель', 2, 'только Chrome');
    expect(records.get('родитель')?.groups[2]?.status).toBe('waiting');

    conveyor.onChainEnded(link(1), true);
    await wait();
    expect(launches).toHaveLength(1);

    conveyor.onChainEnded(link(0), false);
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

    conveyor.onChainEnded(link(0), true);
    conveyor.onChainEnded(link(1), true);
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

    conveyor.onChainEnded({ ...link(0), branch: 'other' }, true);
    conveyor.onChainEnded({ ...link(0), parentChatId: 'кто-то' }, true);
    await wait();
    expect(records.get('родитель')?.groups[0]?.status).toBe('started');

    conveyor.onChainEnded(link(0), true);
    conveyor.onChainEnded(link(0), false);
    await wait();
    expect(records.get('родитель')?.groups[0]?.status).toBe('done');
  });

  it('конец цепочки зовёт сверку веток — по разу на каждый настоящий конец', async () => {
    const { conveyor, link, overlapChecks, wait } = await triaged();

    // Чужая ветка и чужой родитель концом ЭТОГО разделения не считаются.
    conveyor.onChainEnded({ ...link(0), branch: 'other' }, true);
    conveyor.onChainEnded(link(0), true);
    conveyor.onChainEnded(link(1), false);
    // Повторный конец той же ветки: группа уже `done`, сверять нечего.
    conveyor.onChainEnded(link(0), true);
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
    expect(conveyor.view(['никто'])).toBeUndefined();
  });

  it('не запустившийся прогон группы — failed с причиной, остальные идут', async () => {
    const { records } = await triaged({ failLaunch: [0] });

    const record = records.get('родитель') as SplitPlanRecord;
    expect(record.groups[0]).toMatchObject({ status: 'failed', error: 'прогон не запустился' });
    expect(record.groups[1]?.status).toBe('started');
  });
});
