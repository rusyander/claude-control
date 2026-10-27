import { afterEach, describe, expect, it } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { createHandoffPlanner } from './handoff-routes.ts';

/**
 * Группа на паузе не получает следующего звена (журнал 26.10, g8): ревью
 * стартовало через 24 с после паузы — на дереве посреди перебазирования. Пауза
 * конвейера (`SplitConveyor.isPaused`) теперь читается планировщиком сдачи так же,
 * как пауза хода. Конвейер и планировщик настоящие; снаружи — запуск копий и CLI.
 */

const PARENT = 'родитель';
const CWD = 'C:/work/проект-worktrees/paused-group';

/** Настоящий конвейер с одной группой в работе: запуск копий и часы — граница. */
async function conveyorWithGroup(): Promise<SplitConveyor> {
  const records = new Map<string, SplitPlanRecord>();
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => structuredClone(records.get(parent)),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        structuredClone(
          [...records.values()].find((item) => ids.includes(item.triageChatId ?? '')),
        ),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `chat-${index}`,
        path: CWD,
        isWorktree: true,
        started: true,
        prompt: '',
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    parallel: () => 1,
    resume: () => 'sent',
    schedule: () => 0,
    notify: () => undefined,
    log: () => undefined,
    now: () => new Date('2026-10-26T10:00:00.000Z'),
  });
  await conveyor.begin({
    parentChatId: PARENT,
    projectPath: 'C:/work/проект',
    proposal: { groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] }] },
    request: {},
  });
  conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
  await new Promise((done) => setTimeout(done, 5));
  return conveyor;
}

/** Связь работы группы 0 — та, что конвейер узнаёт по родителю и номеру. */
const workLink = (): ChatLink => ({
  parentChatId: PARENT,
  groupIndex: 0,
  createdAt: '2026-10-26T09:00:00.000Z',
  branch: 'feature/one',
  model: 'claude-opus-5',
  effort: 'high',
  kind: 'mechanical',
  lowered: false,
  stage: 'work',
  task: 'Сделай PROJ-1',
  groupTask: 'Сделай PROJ-1',
});

const stopLater: ChatRunRegistry[] = [];
afterEach(() => stopLater.splice(0).forEach((run) => run.stopAll()));

/** Ход работы кончился итогом; что завёл планировщик — запуски и новые связи. */
async function finishWork(conveyor: SplitConveyor, pauseAtSafePoint?: (link: ChatLink) => boolean) {
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (_options, onEvent) => {
      onEvent({ kind: 'text', text: 'Сделал PROJ-1, тесты зелёные.' });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-работы' });
    },
    stop: () => undefined,
  }));
  stopLater.push(registry);
  const links = new Map<string, ChatLink>([['chat-0', workLink()]]);
  const saved: string[] = [];
  const prompts: string[] = [];
  const start = registry.start.bind(registry);
  registry.start = (chatId, opts, meta) => {
    prompts.push(opts.prompt);
    return start(chatId, opts, meta);
  };
  registry.setHandoffPlanner(
    createHandoffPlanner({
      runs: registry,
      chains: new HandoffChains(),
      session: new ChatSession(registry),
      selfBaseUrl: 'http://127.0.0.1:5178',
      stat: () => Date.now(),
      cascade: {
        linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
        saveLink: (chatId, link) => {
          saved.push(chatId);
          links.set(chatId, link);
        },
        markReviewed: () => undefined,
        hasWork: () => true,
        settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
      },
      split: {
        onTriageFinished: () => undefined,
        onChainEnded: (link, outcome) => conveyor.onChainEnded(link, outcome),
        delivers: () => false,
        isPaused: (link) => conveyor.isPaused(link),
        ...(pauseAtSafePoint ? { pauseAtSafePoint } : {}),
      },
    }),
  );
  registry.start('chat-0', { prompt: 'работа', cwd: CWD }, { projectPath: CWD });
  await new Promise((done) => setTimeout(done, 30));
  return { prompts, saved, links };
}

describe('планировщик сдачи: группа на паузе конвейера звена не получает (g8)', () => {
  it('пауза конвейера и законченный ход — ни ревью, ни нового разговора, группа стоит', async () => {
    const conveyor = await conveyorWithGroup();
    conveyor.pause(PARENT, 0);
    expect(conveyor.isPaused(workLink())).toBe(true);

    const { prompts, saved } = await finishWork(conveyor);

    expect(prompts).toEqual(['работа']);
    expect(saved).toEqual([]);
    expect(conveyor.isPaused(workLink())).toBe(true);
  });

  it('без паузы тот же ход заводит ревью новым разговором', async () => {
    const conveyor = await conveyorWithGroup();
    expect(conveyor.isPaused(workLink())).toBe(false);

    const { prompts, saved, links } = await finishWork(conveyor);

    expect(prompts).toHaveLength(2);
    expect(saved).toHaveLength(1);
    expect(links.get(saved[0] ?? '')).toMatchObject({ stage: 'review', groupIndex: 0 });
  });
});

describe('планировщик сдачи: пауза сторожа на безопасной точке (F1)', () => {
  it('сторож держит группу — следующее звено не заводится, группа на паузе сторожа', async () => {
    const conveyor = await conveyorWithGroup();
    const asked: ChatLink[] = [];

    const { prompts, saved } = await finishWork(conveyor, (link) => {
      asked.push(link);
      return conveyor.pauseByWatch(link, 'R4');
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ parentChatId: PARENT, groupIndex: 0 });
    expect(prompts).toEqual(['работа']);
    expect(saved).toEqual([]);
    expect(conveyor.isPaused(workLink())).toBe(true);
    expect(conveyor.view([PARENT])?.groups[0]).toMatchObject({
      pausedBy: 'watch',
      pausedRule: 'R4',
    });
  });

  it('сторож не держит — то же звено ревью заводится как обычно', async () => {
    const conveyor = await conveyorWithGroup();

    const { saved, links } = await finishWork(conveyor, () => false);

    expect(saved).toHaveLength(1);
    expect(links.get(saved[0] ?? '')).toMatchObject({ stage: 'review', groupIndex: 0 });
    expect(conveyor.isPaused(workLink())).toBe(false);
  });
});
