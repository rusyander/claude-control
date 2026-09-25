import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import { SplitConveyor, type ChainOutcome, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Управление группой из хаба (журнал 81, 89): пауза одной группы, её
 * продолжение, «запустить сейчас» из очереди, ожидание сброса лимита подписки и
 * продолжение наблюдателя MR через место под потолком. Конвейер настоящий;
 * снаружи — только запуск копий (git + CLI), продолжение сессии и часы.
 */

const PARENT = 'родитель';
const START = Date.UTC(2026, 8, 24, 15, 30);

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

function build(options: { parallel?: number; groups?: number; refuse?: boolean } = {}) {
  const records = new Map<string, SplitPlanRecord>();
  const launches: number[][] = [];
  const resumed: { index: number; prompt: string }[] = [];
  const notices: { parent: string; event: ChatEvent }[] = [];
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
      launches.push(groups);
      return {
        chats: groups.map((index) => ({
          index,
          title: record.proposal.groups[index]?.title ?? '',
          branch: record.groups[index]?.branch ?? '',
          chatId: `chat-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: true,
          prompt: '',
        })),
        failures: [],
      };
    },
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    ...(options.parallel ? { parallel: () => options.parallel as number } : {}),
    resume: (group, prompt) => {
      if (options.refuse) return 'refused';
      resumed.push({ index: group.index, prompt });
      return 'sent';
    },
    schedule: (run, ms) => {
      timers.push({ at: clock.now + ms, run });
      return timers.length;
    },
    notify: (parent, event) => void notices.push({ parent, event }),
    log: () => undefined,
    now: () => new Date(clock.now),
  };
  const conveyor = new SplitConveyor(deps);
  const link = (index: number): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: proposal.groups[index]?.branch ?? '',
    groupIndex: index,
    stage: 'work',
  });
  /** Разбор применён без блока: все группы в очереди по порядку. */
  const begin = async (): Promise<void> => {
    await conveyor.begin({ parentChatId: PARENT, projectPath: 'C:/repo', proposal, request: {} });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await flush();
  };
  const flush = () => new Promise((done) => setTimeout(done, 5));
  /** Часы вперёд: срабатывают таймеры, чей срок настал. */
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
  const group = (index: number) => records.get(PARENT)?.groups[index];
  return {
    conveyor,
    deps,
    records,
    launches,
    resumed,
    notices,
    timers,
    clock,
    link,
    begin,
    flush,
    advance,
    group,
  };
}

const limitOutcome = (at: number): ChainOutcome => ({
  status: 'awaiting',
  waitingFor: 'limit',
  limitUntil: new Date(at).toISOString(),
});

describe('SplitConveyor: пауза группы (журнал 81a)', () => {
  it('пауза отдаёт место: следующая из очереди стартует, ждавшие стоят', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    expect(t.launches).toEqual([[0]]);

    const paused = t.conveyor.pause(PARENT, 0);
    await t.flush();

    expect(paused.chatIds).toEqual(['chat-0']);
    expect(t.group(0)?.status).toBe('paused');
    expect(t.group(0)?.pausedAt).toBe(new Date(START).toISOString());
    // Место свободно — очередь двинулась.
    expect(t.launches).toEqual([[0], [1]]);
    expect(t.conveyor.view([PARENT])?.groups[0]).toMatchObject({ status: 'paused' });
  });

  it('конец хода остановленной группы её не закрывает; новый прогон — снова «работает»', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    t.conveyor.onChainEnded(t.link(0), { status: 'failed', error: 'остановлен' });
    expect(t.group(0)?.status).toBe('paused');

    t.conveyor.onChainResumed(t.link(0), 'chat-0');
    expect(t.group(0)?.status).toBe('started');
    expect(t.group(0)?.pausedAt).toBeUndefined();
  });

  it('остановка человеком в чате группы ставит её на паузу (pauseByLink)', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    expect(t.conveyor.pauseByLink(t.link(0))).toBe(true);
    await t.flush();
    expect(t.group(0)?.status).toBe('paused');
    expect(t.conveyor.isPaused(t.link(0))).toBe(true);
    expect(t.launches).toEqual([[0], [1]]);
    // Закрытую группу пауза не трогает.
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    expect(t.conveyor.pauseByLink(t.link(1))).toBe(false);
  });

  it('паузить нечего — отказ с кодом', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    expect(() => t.conveyor.pause(PARENT, 2)).toThrow(
      expect.objectContaining({ messageCode: 'split-pause-not-running' }),
    );
  });

  it('«Продолжить» занимает место: потолок полон — отказ с числами, с согласием — сверх', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    await t.flush();
    expect(t.group(1)?.status).toBe('started');

    expect(() => t.conveyor.resumePaused(PARENT, 0)).toThrow(
      expect.objectContaining({
        messageCode: 'split-group-no-slot',
        params: { running: '1', limit: '1' },
      }),
    );
    expect(t.resumed).toEqual([]);

    expect(t.conveyor.resumePaused(PARENT, 0, true)).toBe('sent');
    expect(t.resumed[0]?.index).toBe(0);
    expect(t.resumed[0]?.prompt).toMatch(/^Ветка группы: feature\/one\. Задачи группы: PROJ-1\./);
    expect(t.resumed[0]?.prompt).toMatch(/поставил группу на паузу/);
  });

  it('«Продолжить» при свободном месте — сразу; не на паузе — отказ', async () => {
    const t = build({ parallel: 2, groups: 2 });
    await t.begin();
    t.conveyor.pause(PARENT, 1);
    expect(t.conveyor.resumePaused(PARENT, 1)).toBe('sent');
    expect(() => t.conveyor.resumePaused(PARENT, 0)).toThrow(
      expect.objectContaining({ messageCode: 'split-resume-not-paused' }),
    );
  });

  it('продолжить нечем (нет сессии) — отказ с кодом, группа остаётся на паузе', async () => {
    const t = build({ parallel: 2, refuse: true });
    await t.begin();
    t.conveyor.pause(PARENT, 0);
    expect(() => t.conveyor.resumePaused(PARENT, 0)).toThrow(
      expect.objectContaining({ messageCode: 'split-resume-refused' }),
    );
    expect(t.group(0)?.status).toBe('paused');
  });
});

describe('SplitConveyor: «запустить сейчас» из очереди (TK-startnow)', () => {
  it('мимо порядка; потолок полон — отказ, с согласием — сверх потолка', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    expect(t.group(2)?.status).toBe('pending');

    await expect(t.conveyor.startNow(PARENT, 2)).rejects.toMatchObject({
      messageCode: 'split-group-no-slot',
    });
    expect(t.launches).toEqual([[0]]);

    const result = await t.conveyor.startNow(PARENT, 2, true);
    expect(result.chats.map((chat) => chat.index)).toEqual([2]);
    expect(t.launches).toEqual([[0], [2]]);
    expect(t.group(2)?.status).toBe('started');
    // Первая в очереди осталась ждать своего места.
    expect(t.group(1)?.status).toBe('pending');
  });

  it('не из очереди — отказ с кодом', async () => {
    const t = build({ parallel: 1 });
    await t.begin();
    await expect(t.conveyor.startNow(PARENT, 0)).rejects.toMatchObject({
      messageCode: 'split-start-not-queued',
    });
  });
});

describe('SplitConveyor: лимит подписки (журнал 81b, 89)', () => {
  it('группа ждёт сброса: место держит, очередь не жжёт старты, заметка родителю одна', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    expect(t.launches).toEqual([[0, 1]]);
    const reset = START + 70 * 60_000;

    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    t.conveyor.onChainEnded(t.link(1), limitOutcome(reset));
    await t.flush();

    expect(t.group(0)).toMatchObject({ status: 'awaiting', waitingFor: 'limit' });
    expect(t.group(0)?.limitUntil).toBe(new Date(reset).toISOString());
    expect(t.records.get(PARENT)?.limitUntil).toBe(new Date(reset).toISOString());
    expect(t.launches).toEqual([[0, 1]]);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.event).toMatchObject({
      kind: 'notice',
      code: 'groupsLimited',
      textCode: 'split-limit-wait-notice',
    });
    // Момент, а не готовые часы сервера: часы считает клиент в поясе читающего (W3-5).
    expect((t.notices[0]?.event as { textParams?: unknown }).textParams).toEqual({
      until: new Date(reset).toISOString(),
    });
    expect(t.conveyor.view([PARENT])?.limitUntil).toBe(new Date(reset).toISOString());
  });

  /**
   * Аудит 25.09, L63: `allowed_warning` — лимит ещё не кончился, но на исходе.
   * Ход прошёл, а очередь раньше заводила новые группы прямо в стену отказа.
   */
  it('лимит на исходе: ход закрыт, новые группы ждут сброса, заметка своя', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const reset = START + 30 * 60_000;
    t.conveyor.onChainEnded(t.link(0), {
      status: 'done',
      limitWarningUntil: new Date(reset).toISOString(),
    });
    await t.flush();

    expect(t.group(0)?.status).toBe('done');
    expect(t.launches).toEqual([[0, 1]]);
    expect(t.notices.map((notice) => notice.event)).toEqual([
      expect.objectContaining({ code: 'groupsLimited', textCode: 'split-limit-warning-notice' }),
    ]);
    expect(t.conveyor.view([PARENT])).toMatchObject({
      limitUntil: new Date(reset).toISOString(),
      limitWarning: true,
    });

    await t.advance(30 * 60_000);
    expect(t.launches).toEqual([[0, 1], [2]]);
    expect(t.records.get(PARENT)?.limitWarning).toBeUndefined();
  });

  it('срок предупреждения в прошлом очередь не держит', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    t.conveyor.onChainEnded(t.link(0), {
      status: 'done',
      limitWarningUntil: new Date(START - 1_000).toISOString(),
    });
    await t.flush();
    expect(t.launches).toEqual([[0, 1], [2]]);
    expect(t.notices).toEqual([]);
  });

  it('пока лимит, место освободилось — очередь всё равно ждёт; после сброса продолжает всё', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const reset = START + 60 * 60_000;
    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.launches).toEqual([[0, 1]]);

    await t.advance(60 * 60_000 - 1);
    expect(t.resumed).toEqual([]);

    await t.advance(1);
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
    expect(t.resumed[0]?.prompt).toMatch(/лимит/);
    expect(t.launches).toEqual([[0, 1], [2]]);
    expect(t.records.get(PARENT)?.limitUntil).toBeUndefined();
  });

  it('несколько групп после сброса продолжаются не разом, а по одной с паузой', async () => {
    const t = build({ parallel: 3 });
    await t.begin();
    const reset = START + 10 * 60_000;
    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    t.conveyor.onChainEnded(t.link(1), limitOutcome(reset));
    await t.advance(10 * 60_000);
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
    await t.advance(60_000);
    expect(t.resumed.map((item) => item.index)).toEqual([0, 1]);
  });

  it('перезапуск панели: ожидание в записи, recoverLimitWaits ставит таймер заново', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const reset = START + 30 * 60_000;
    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    t.timers.length = 0; // таймер умер вместе с процессом

    const reborn = new SplitConveyor(t.deps);
    reborn.recoverLimitWaits();
    expect(t.timers).toHaveLength(1);
    await t.advance(30 * 60_000);
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
  });

  it('сброс уже прошёл к перезапуску — продолжает сразу', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    t.conveyor.onChainEnded(t.link(0), limitOutcome(START + 60_000));
    t.timers.length = 0;
    t.clock.now += 5 * 60_000;
    new SplitConveyor(t.deps).recoverLimitWaits();
    await t.advance(0);
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
  });

  it('«запустить сейчас» во время лимита — отказ с временем сброса, с согласием — старт', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const reset = START + 60 * 60_000;
    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    // Место паузы свободно, но лимит держит очередь: третья остаётся ждать.
    t.conveyor.pause(PARENT, 1);
    await t.flush();
    expect(t.group(2)?.status).toBe('pending');
    await expect(t.conveyor.startNow(PARENT, 2)).rejects.toMatchObject({
      messageCode: 'split-limit-active',
      params: { until: new Date(reset).toISOString() },
    });
    const refusal = (await t.conveyor.startNow(PARENT, 2).catch((error: unknown) => error)) as {
      params?: unknown;
    };
    expect(refusal.params).toEqual({ until: new Date(reset).toISOString() });
    expect(() => t.conveyor.resumePaused(PARENT, 1)).toThrow(
      expect.objectContaining({ messageCode: 'split-limit-active' }),
    );
    expect(t.conveyor.resumePaused(PARENT, 1, true)).toBe('sent');
  });

  it('пауза снимает ожидание лимита: после сброса группа сама не продолжается', async () => {
    const t = build({ parallel: 2 });
    await t.begin();
    const reset = START + 60_000;
    t.conveyor.onChainEnded(t.link(0), limitOutcome(reset));
    t.conveyor.pause(PARENT, 0);
    await t.advance(60_000);
    expect(t.resumed).toEqual([]);
    expect(t.group(0)?.status).toBe('paused');
  });

  it('продолжить после сброса нечем — группа «прервана» и ждёт кнопки', async () => {
    const t = build({ parallel: 2, refuse: true });
    await t.begin();
    t.conveyor.onChainEnded(t.link(0), limitOutcome(START + 60_000));
    await t.advance(60_000);
    expect(t.group(0)).toMatchObject({ status: 'awaiting', waitingFor: 'interrupted' });
  });
});

describe('SplitConveyor: продолжение доставленной группы через место (WP1j + потолок)', () => {
  const deliver = async (t: ReturnType<typeof build>): Promise<void> => {
    const record = t.records.get(PARENT);
    if (!record?.groups[0]) throw new Error('нет группы');
    record.groups[0].deliver = true;
    t.records.set(PARENT, record);
    t.conveyor.onChainEnded(t.link(0), { status: 'done' });
    await t.flush();
  };

  it('потолок полон — продолжение ждёт места и уходит, как только оно освободится', async () => {
    const t = build({ parallel: 1, groups: 2 });
    await t.begin();
    await deliver(t);
    expect(t.group(1)?.status).toBe('started');

    expect(t.conveyor.resumeDelivered(PARENT, 0, 'ветки ревьюера')).toBe('queued');
    expect(t.resumed).toEqual([]);
    expect(t.group(0)?.parked?.prompt).toMatch(/ветки ревьюера$/);
    expect(t.conveyor.view([PARENT])?.groups[0]?.parkedAt).toBeDefined();

    t.conveyor.onChainEnded(t.link(1), { status: 'done' });
    await t.flush();
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
    expect(t.resumed[0]?.prompt).toMatch(/^Ветка группы: feature\/one\./);
    expect(t.group(0)?.parked).toBeUndefined();
  });

  it('место есть — уходит сразу, как раньше', async () => {
    const t = build({ parallel: 2, groups: 2 });
    await t.begin();
    await deliver(t);
    expect(t.conveyor.resumeDelivered(PARENT, 0, 'ветки')).toBe('sent');
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
  });

  it('во время лимита продолжение ждёт сброса', async () => {
    const t = build({ parallel: 3, groups: 2 });
    await t.begin();
    await deliver(t);
    t.conveyor.onChainEnded(t.link(1), limitOutcome(START + 60_000));
    expect(t.conveyor.resumeDelivered(PARENT, 0, 'ветки')).toBe('queued');
    expect(t.resumed).toEqual([]);
    await t.advance(60_000);
    expect(t.resumed.map((item) => item.index).sort()).toEqual([0, 1]);
  });
});
