import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { SplitGroupContext } from '../ChatSplit/ChatSplit.ts';
import { SplitConveyor, claimedBranches, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Пауза человека и то, что вокруг неё (живой прогон 29.09): пауза во время
 * подготовки копии, пауза группы из очереди, пауза без каскада стартов и
 * группа, оборванная до своего чата. Конвейер настоящий; снаружи — запуск копий
 * (с подготовкой, которую тест держит сколько нужно), продолжение сессии и часы.
 */

const PARENT = 'родитель';
const START = Date.UTC(2026, 8, 29, 9, 40);

const GROUPS = [
  { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] },
  { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 вторая'] },
  { title: 'Три', branch: 'feature/three', tasks: ['PROJ-3 третья'] },
];

function build(options: { parallel?: number; failLaunch?: boolean; failCopies?: boolean } = {}) {
  const records = new Map<string, SplitPlanRecord>();
  const launches: { groups: number[]; context?: SplitGroupContext }[] = [];
  /** Группы, чей прогон запуск действительно стартовал. */
  const started: number[] = [];
  const resumed: number[] = [];
  /** Подготовка копий (npm ci): пока не отпущена, запуск не возвращается. */
  let setup: Promise<void> | undefined;
  let finishSetup = (): void => undefined;
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
    launch: async (record, groups, context, claim, startable): Promise<TaskSplitResult> => {
      launches.push({ groups, ...(context ? { context } : {}) });
      for (const index of groups) {
        const copy = context?.copy ?? {
          path: `C:/copies/${index}`,
          branch: record.groups[index]?.branch ?? '',
        };
        claim(index, copy.branch, copy.path);
      }
      if (setup) await setup;
      if (options.failLaunch) throw new Error('worktree add упал');
      // Как `splitTasks`: ошибка копии приходит ответом, а не исключением.
      if (options.failCopies) {
        return {
          chats: [],
          failures: groups.map((index) => ({
            index,
            title: GROUPS[index]?.title ?? '',
            branch: GROUPS[index]?.branch ?? '',
            message: 'worktree add упал',
          })),
        };
      }
      return {
        chats: groups.map((index) => {
          // Как `splitTasks`: спросить конвейер прямо перед стартом прогона.
          const go = startable ? startable(index) : true;
          if (go) started.push(index);
          return {
            index,
            title: record.proposal.groups[index]?.title ?? '',
            branch: context?.copy?.branch ?? record.groups[index]?.branch ?? '',
            chatId: `chat-${index}`,
            path: context?.copy?.path ?? `C:/copies/${index}`,
            isWorktree: true,
            started: go,
            ...(go ? {} : { held: true }),
            prompt: '',
          };
        }),
        failures: [],
      };
    },
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    ...(options.parallel ? { parallel: () => options.parallel as number } : {}),
    resume: (group) => {
      resumed.push(group.index);
      return 'sent';
    },
    schedule: () => 0,
    log: () => undefined,
    now: () => new Date(START),
  };
  const conveyor = new SplitConveyor(deps);
  const flush = () => new Promise((done) => setTimeout(done, 5));
  const begin = async (): Promise<void> => {
    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: 'C:/repo',
      proposal: { groups: GROUPS },
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await flush();
  };
  const link = (index: number): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: GROUPS[index]?.branch ?? '',
    groupIndex: index,
    stage: 'work',
  });
  return {
    conveyor,
    records,
    launches,
    started,
    resumed,
    flush,
    begin,
    link,
    group: (index: number) => records.get(PARENT)?.groups[index],
    /** Подготовка копий идёт, пока тест её не отпустит. */
    holdSetup: () => {
      setup = new Promise((done) => {
        finishSetup = () => {
          setup = undefined;
          done();
        };
      });
    },
    finishSetup: async () => {
      finishSetup();
      await flush();
    },
  };
}

describe('W1: пауза во время подготовки копии держится', () => {
  it('подготовка кончилась — прогон на паузе не стартует, копия записана', async () => {
    const t = build({ parallel: 2 });
    t.holdSetup();
    await t.begin();
    expect(t.group(1)?.status).toBe('started');

    // Процесса ещё нет — останавливать нечего.
    expect(t.conveyor.pause(PARENT, 1).chatIds).toEqual([]);
    await t.finishSetup();

    expect(t.started).toEqual([0]);
    expect(t.group(1)?.status).toBe('paused');
    expect(t.group(1)?.chatId).toBeUndefined();
    expect(t.group(1)?.path).toBe('C:/copies/1');
    expect(t.group(0)?.status).toBe('started');
  });

  it('«Продолжить» такой группы стартует её в уже готовой копии', async () => {
    const t = build({ parallel: 2 });
    t.holdSetup();
    await t.begin();
    t.conveyor.pause(PARENT, 1);
    await t.finishSetup();

    expect(t.conveyor.resumePaused(PARENT, 1)).toBe('sent');
    await t.flush();
    expect(t.launches.at(-1)).toMatchObject({
      groups: [1],
      context: { copy: { path: 'C:/copies/1', branch: 'feature/two' } },
    });
    expect(t.started).toEqual([0, 1]);
    expect(t.group(1)?.status).toBe('started');
    expect(t.resumed).toEqual([]);
  });

  it('план отменён во время подготовки — прогоны не стартуют', async () => {
    const t = build({ parallel: 2 });
    t.holdSetup();
    await t.begin();
    t.conveyor.cancel(PARENT);
    await t.finishSetup();
    expect(t.started).toEqual([]);
    expect(t.group(0)?.status).toBe('failed');
  });

  // Холодная проверка 29.09 (N9): тот же класс через ответ с `failures`.
  it('N9: ошибка копии в ответе запуска не затирает паузу', async () => {
    const t = build({ parallel: 2, failCopies: true });
    t.holdSetup();
    await t.begin();
    t.conveyor.pause(PARENT, 1);
    await t.finishSetup();
    expect(t.group(1)?.status).toBe('paused');
    expect(t.group(1)?.error).toBeUndefined();
    expect(t.group(0)).toMatchObject({ status: 'failed', error: 'worktree add упал' });
  });

  it('N9: ошибка копии в ответе запуска не подменяет причину отмены плана', async () => {
    const t = build({ parallel: 2, failCopies: true });
    t.holdSetup();
    await t.begin();
    t.conveyor.cancel(PARENT);
    const cancelled = t.group(0)?.error;
    await t.finishSetup();
    expect(cancelled).toBeTruthy();
    expect(t.group(0)?.error).toBe(cancelled);
  });
});

describe('W2: группу из очереди можно поставить на паузу', () => {
  it('пауза очереди: конвейер её пропускает, «Продолжить» возвращает в очередь', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    expect(t.group(2)?.status).toBe('pending');

    expect(t.conveyor.pause(PARENT, 2).chatIds).toEqual([]);
    expect(t.group(2)?.status).toBe('paused');

    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0], [1]]);
    expect(t.group(2)?.status).toBe('paused');

    // Место свободно — вернулась в очередь и тут же стартовала.
    expect(t.conveyor.resumePaused(PARENT, 2)).toBe('queued');
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0], [1], [2]]);
    expect(t.group(2)?.status).toBe('started');
  });

  it('пауза очереди место не держит: соседняя из очереди идёт своим чередом', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.pause(PARENT, 1);
    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0], [2]]);
  });
});

describe('W3: пауза человека не запускает очередь', () => {
  it('пауза работающей держит её место: ждущие в очереди не стартуют', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0, 1]]);

    t.conveyor.pause(PARENT, 0);
    t.conveyor.pause(PARENT, 1);
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0, 1]]);
    expect(t.group(2)?.status).toBe('pending');

    // Перезапуск панели очередь тоже не будит: места держат паузы.
    t.conveyor.recoverLimitWaits();
    await t.flush();
    expect(t.launches).toHaveLength(1);
  });

  it('«Продолжить» занимает своё же место — без отказа по потолку', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    await t.flush();
    expect(t.conveyor.resumePaused(PARENT, 0)).toBe('sent');
    expect(t.resumed).toEqual([0]);
    expect(t.group(1)?.status).toBe('pending');
  });

  it('место освобождает конец цепочки, а не пауза', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0, 1], [2]]);
  });
});

describe('W4: группа, оборванная до своего чата, не тупик', () => {
  /** Перезапуск панели посреди подготовки: копия есть, чата нет. */
  const cut = async () => {
    const t = build({ parallel: 1 });
    t.holdSetup();
    await t.begin();
    t.conveyor.recoverInterruptedGroups(() => false);
    const group = t.group(0);
    expect(group).toMatchObject({ status: 'awaiting', waitingFor: 'interrupted' });
    expect(group?.chatId).toBeUndefined();
    return t;
  };

  it('«Завести заново» стартует группу в её копии', async () => {
    const t = await cut();
    await t.finishSetup();
    // Старый запуск вернулся, но группа уже прервана — его прогон не пускаем.
    expect(t.started).toEqual([]);

    await t.conveyor.restartGroup(PARENT, 0);
    await t.flush();
    expect(t.launches.at(-1)).toMatchObject({
      groups: [0],
      context: { copy: { path: 'C:/copies/0', branch: 'feature/one' } },
    });
    expect(t.started).toEqual([0]);
    expect(t.group(0)?.status).toBe('started');
    expect(t.group(0)?.chatId).toBe('chat-0');
  });

  it('«Убрать» закрывает группу, место уходит очереди', async () => {
    const t = await cut();
    await t.finishSetup();
    t.conveyor.dropGroup(PARENT, 0);
    await t.flush();
    expect(t.group(0)).toMatchObject({ status: 'failed' });
    expect(t.group(0)?.error).toMatch(/убрана человеком/);
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0], [1]]);
  });

  it('у группы с чатом — отказ: её продолжают, а не заводят заново', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.recoverInterruptedGroups(() => false);
    await expect(t.conveyor.restartGroup(PARENT, 0)).rejects.toMatchObject({
      messageCode: 'split-restart-not-cut',
    });
    expect(() => t.conveyor.dropGroup(PARENT, 0)).toThrow(
      expect.objectContaining({ messageCode: 'split-drop-nothing' }),
    );
  });
});

describe('ревью r1: гонки паузы с подготовкой и выходы из паузы', () => {
  it('A1: пауза и «Продолжить» во время подготовки — один запуск, один прогон', async () => {
    const t = build({ parallel: 1 });
    t.holdSetup();
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    expect(t.conveyor.resumePaused(PARENT, 0)).toBe('sent');
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0]]);
    expect(t.group(0)?.status).toBe('started');
    await t.finishSetup();
    expect(t.started.filter((index) => index === 0)).toHaveLength(1);
    expect(t.group(0)?.chatId).toBe('chat-0');
  });

  it('A2: пауза очереди, пока предыдущая порция того же насоса в подготовке, держится', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const record = t.records.get(PARENT) as SplitPlanRecord;
    record.groups[0]!.status = 'done';
    for (const index of [1, 2]) {
      const group = record.groups[index]!;
      group.status = 'pending';
      delete group.startedAt;
      delete group.chatId;
      delete group.path;
      group.hold = 'вопрос';
      group.holdAnswer = `ответ ${index}`;
    }
    t.records.set(PARENT, record);
    t.started.length = 0;
    t.holdSetup();
    t.conveyor.recoverLimitWaits();
    await t.flush();
    // Порция группы 1 в подготовке; группа 2 ждёт своей порции следом.
    t.conveyor.pause(PARENT, 2);
    await t.finishSetup();
    await t.flush();
    expect(t.group(2)?.status).toBe('paused');
    expect(t.started).toEqual([1]);
  });

  it('A3: пауза до записи копии и перезапуск — «Продолжить» заводит группу заново', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    const record = t.records.get(PARENT) as SplitPlanRecord;
    const group = record.groups[0]!;
    group.status = 'paused';
    group.pausedAt = new Date(START).toISOString();
    delete group.chatId;
    delete group.path;
    t.records.set(PARENT, record);
    t.started.length = 0;

    expect(t.conveyor.resumePaused(PARENT, 0)).toBe('sent');
    await t.flush();
    expect(t.launches.at(-1)?.groups).toEqual([0]);
    expect(t.launches.at(-1)?.context?.copy).toBeUndefined();
    expect(t.started).toEqual([0]);
    expect(t.group(0)?.status).toBe('started');
  });

  it('A4: «Убрать» закрывает и группу на паузе — место уходит очереди', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    await t.flush();
    expect(t.launches).toHaveLength(1);
    t.conveyor.dropGroup(PARENT, 0);
    await t.flush();
    expect(t.group(0)).toMatchObject({ status: 'failed' });
    expect(t.group(0)?.pausedAt).toBeUndefined();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0], [1]]);
  });

  it('A10: потолок, занятый паузами, так и назван — паузы отдельно', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    await expect(t.conveyor.startNow(PARENT, 1)).rejects.toMatchObject({
      messageCode: 'split-group-no-slot-paused',
      params: { running: '0', paused: '1', limit: '1' },
    });
  });

  it('A11: «Завести заново» отвечает сразу, не дожидаясь подготовки', async () => {
    const t = build({ parallel: 1 });
    t.holdSetup();
    await t.begin();
    t.conveyor.recoverInterruptedGroups(() => false);
    await t.finishSetup();
    t.holdSetup();
    let answered = false;
    void t.conveyor.restartGroup(PARENT, 0).then(() => {
      answered = true;
    });
    await t.flush();
    expect(answered).toBe(true);
    expect(t.group(0)?.status).toBe('started');
    await t.finishSetup();
    expect(t.started).toEqual([0]);
  });

  it('A12: сбой запуска не затирает паузу, поставленную во время подготовки', async () => {
    const t = build({ parallel: 2, failLaunch: true });
    t.holdSetup();
    await t.begin();
    t.conveyor.pause(PARENT, 1);
    await t.finishSetup();
    expect(t.group(1)?.status).toBe('paused');
    expect(t.group(1)?.error).toBeUndefined();
    expect(t.group(0)?.status).toBe('failed');
  });
});

// Холодная проверка 29.09 (N2): чужие ветки плана своей группе не отдаются.
describe('claimedBranches', () => {
  it('ветки остальных групп и основания всех копий, без своей ветки', () => {
    const record = {
      groups: [
        { branch: 'fix/PROJ-1' },
        { branch: 'fix/PROJ-1-tests', base: 'fix/PROJ-1' },
        { branch: 'feature/two', base: 'develop' },
      ],
    } as unknown as SplitPlanRecord;
    expect(claimedBranches(record, 1).sort()).toEqual(['develop', 'feature/two', 'fix/PROJ-1']);
  });

  // Ревью r2 (R4): ветки групп прежнего плана того же разговора — тоже чужие.
  it('ветки групп прежнего плана', () => {
    const record = {
      groups: [{ branch: 'fix/PROJ-1-tests' }],
      retiredGroups: [{ branch: 'fix/PROJ-1' }],
    } as unknown as SplitPlanRecord;
    expect(claimedBranches(record, 0)).toEqual(['fix/PROJ-1']);
  });
});

describe('ревью 30.09: разбор, перезапуск и «Завести заново»', () => {
  const beginWithoutTriageEnd = async (t: ReturnType<typeof build>): Promise<void> => {
    await t.conveyor.begin({
      parentChatId: PARENT,
      projectPath: 'C:/repo',
      proposal: { groups: GROUPS },
      request: {},
    });
    await t.flush();
  };

  it('перезапуск панели посреди разбора групп не заводит — их заводит разбор, один раз', async () => {
    const t = build({ parallel: 2 });
    await beginWithoutTriageEnd(t);
    expect(t.launches).toEqual([]);

    t.conveyor.recoverLimitWaits();
    await t.flush();
    expect(t.launches).toEqual([]);

    t.conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await t.flush();
    expect(t.launches.map((launch) => launch.groups)).toEqual([[0, 1]]);
  });

  it('пауза и «Продолжить» группы из очереди посреди разбора её не заводят', async () => {
    const t = build({ parallel: 2 });
    await beginWithoutTriageEnd(t);
    t.conveyor.pause(PARENT, 0);
    expect(t.conveyor.resumePaused(PARENT, 0)).toBe('queued');
    await t.flush();
    expect(t.launches).toEqual([]);
  });

  it('«Завести заново», пока прежний запуск ещё готовит копию, — второго прогона нет', async () => {
    const t = build({ parallel: 1 });
    t.holdSetup();
    await t.begin();
    t.conveyor.recoverInterruptedGroups(() => false);
    expect(t.group(0)).toMatchObject({ status: 'awaiting', waitingFor: 'interrupted' });

    await t.conveyor.restartGroup(PARENT, 0);
    await t.flush();
    expect(t.launches).toHaveLength(1);
    await t.finishSetup();
    expect(t.started).toEqual([0]);
    expect(t.group(0)).toMatchObject({ status: 'started', chatId: 'chat-0' });
    expect(t.group(0)?.waitingFor).toBeUndefined();
  });

  it('заведённая заново группа не несёт метку обрыва', async () => {
    const t = build({ parallel: 1 });
    t.holdSetup();
    await t.begin();
    t.conveyor.recoverInterruptedGroups(() => false);
    await t.finishSetup();

    await t.conveyor.restartGroup(PARENT, 0);
    await t.flush();
    expect(t.group(0)?.status).toBe('started');
    expect(t.group(0)?.waitingFor).toBeUndefined();
    expect(t.group(0)?.interruptedAt).toBeUndefined();
  });
});
