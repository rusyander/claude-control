import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { SplitConveyor } from '../../chat/split-conveyor/split-conveyor.ts';
import type { ProviderChatService } from '../ProviderChatService/ProviderChatService.ts';
import { appendMessage, createChat, readChatCascade } from '../store/store.ts';
import { createForeignStagePlanner } from './cascade.ts';

/**
 * Группа чужого CLI на паузе не получает следующего звена (журнал 26.10, g8) —
 * как у Claude: ревью после паузы стартовало бы на дереве посреди перебазирования.
 * Пауза — настоящего конвейера (`SplitConveyor.isPaused`), разговоры — настоящее
 * хранилище чужого CLI во временной папке; заглушен только запуск CLI (`send`).
 */

const PARENT = 'codex:parent';

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
        chatId: `codex:work-${index}`,
        path: 'C:/copies/0',
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
    projectPath: 'C:/repo',
    proposal: { groups: [{ title: 'Переименование', branch: 'split/rename', tasks: ['PROJ-1'] }] },
    request: {},
  });
  conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
  await new Promise((done) => setTimeout(done, 5));
  return conveyor;
}

describe('createForeignStagePlanner: группа на паузе конвейера (g8)', () => {
  let dir: string;
  const provider = { id: 'codex', name: 'Codex' } as ConfigProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pcascade-paused-'));
    createChat(dir, 'codex', {
      id: 'work-0',
      title: 'Переименование',
      workdir: dir,
      model: 'gpt-5.3-codex-spark',
      effort: 'medium',
      cascade: {
        stage: 'work',
        group: 'Переименование',
        branch: 'split/rename',
        kind: 'mechanical',
        lowered: true,
        workModel: 'gpt-5.3-codex-spark',
        workEffort: 'medium',
      },
    });
    appendMessage(dir, 'codex', 'work-0', { role: 'user', content: 'Переименуй foo в bar' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Ход работы кончился итогом; что завёл планировщик — вызовы CLI и новые связи. */
  async function finishWork(
    conveyor: SplitConveyor,
    pauseAtSafePoint?: (link: ChatLink) => boolean,
  ) {
    const links: Record<string, ChatLink> = {
      'codex:work-0': {
        parentChatId: PARENT,
        groupIndex: 0,
        title: 'Переименование',
        branch: 'split/rename',
        createdAt: '2026-10-26T09:00:00.000Z',
        conversation: 'codex:work-0',
      },
    };
    const send = vi.fn().mockReturnValue({ ok: true });
    await createForeignStagePlanner({
      chats: { send } as unknown as ProviderChatService,
      provider: (id) => (id === 'codex' ? provider : undefined),
      models: () => [],
      settings: () => ({ taskSplitInitiative: false, handoffInitiative: false }),
      hasWork: () => true,
      linkOf: (key) => links[key],
      saveLink: (key, link) => {
        links[key] = link;
      },
      onChainEnded: (link, outcome) => conveyor.onChainEnded(link, outcome),
      isPaused: (link) => conveyor.isPaused(link),
      ...(pauseAtSafePoint ? { pauseAtSafePoint } : {}),
    })({
      providerId: 'codex',
      appDataDir: dir,
      startedAt: 0,
      chatId: 'work-0',
      ok: true,
      text: 'сделал',
    });
    return { send, links };
  }

  it('пауза конвейера и законченный ход — ни ревью, ни нового разговора', async () => {
    const conveyor = await conveyorWithGroup();
    conveyor.pause(PARENT, 0);

    const { send, links } = await finishWork(conveyor);

    expect(send).not.toHaveBeenCalled();
    expect(Object.keys(links)).toEqual(['codex:work-0']);
    expect(readChatCascade(dir, 'codex', 'work-0')?.reviewedAt).toBeFalsy();
    expect(conveyor.isPaused(links['codex:work-0'] as ChatLink)).toBe(true);
  });

  it('F1: сторож держит группу — ни ревью, ни нового разговора, группа на паузе сторожа', async () => {
    const conveyor = await conveyorWithGroup();
    const asked: ChatLink[] = [];

    const { send, links } = await finishWork(conveyor, (link) => {
      asked.push(link);
      return conveyor.pauseByWatch(link, 'R21');
    });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ parentChatId: PARENT, groupIndex: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(Object.keys(links)).toEqual(['codex:work-0']);
    expect(conveyor.view([PARENT])?.groups[0]).toMatchObject({
      pausedBy: 'watch',
      pausedRule: 'R21',
    });
  });

  it('F1: сторож не держит — ревью заводится как обычно', async () => {
    const conveyor = await conveyorWithGroup();

    const { send } = await finishWork(conveyor, () => false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(
      conveyor.isPaused({ parentChatId: PARENT, groupIndex: 0, createdAt: '' } as ChatLink),
    ).toBe(false);
  });

  it('без паузы тот же ход заводит ревью новым разговором', async () => {
    const conveyor = await conveyorWithGroup();

    const { send, links } = await finishWork(conveyor);

    expect(send).toHaveBeenCalledTimes(1);
    const [, , nextId] = send.mock.calls[0] as [string, string, string];
    expect(links[`codex:${nextId}`]).toMatchObject({ stage: 'review', groupIndex: 0 });
  });
});
