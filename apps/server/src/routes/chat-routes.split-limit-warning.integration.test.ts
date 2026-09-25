import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { createHandoffPlanner } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

/**
 * Лимит подписки «на исходе» (аудит 25.09, L63) по НАСТОЯЩЕМУ пути: реестр
 * прогонов, планировщик цепочки, `chainOutcomeOf`, конвейер и хранилище плана.
 * Подменён только процесс CLI — он шлёт событие лимита и текст хода.
 */

const CWD = 'C:/work/проект-worktrees/rename';
const PARENT = 'родитель';
const RESETS_AT = Math.floor(Date.now() / 1000) + 3_600;

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-09-25T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  stage: 'fix',
};

describe('лимит «на исходе» в ходе группы разделения', () => {
  let root: string;
  let store: AppStore;
  let conveyor: SplitConveyor;
  let registry: ChatRunRegistry;
  let reply: string;
  let limit: { resetsAt: number; status: string } | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-limit-warn-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: CWD,
      createdAt: LINK.createdAt,
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [
        {
          index: 0,
          title: 'Переименования',
          branch: 'split/rename',
          after: [],
          status: 'started',
          chatId: 'чат-группы',
        },
      ],
    });
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async () => ({ chats: [], failures: [] }),
      startTriage: () => ({ chatId: '', started: false, deferred: false }),
      log: () => undefined,
    });

    reply = '';
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (_options, onEvent) => {
        // Событие лимита подписки хода — как его отдаёт поток CLI.
        if (limit)
          onEvent({
            kind: 'limit',
            resetsAt: limit.resetsAt,
            type: 'five_hour',
            status: limit.status,
          });
        onEvent({ kind: 'text', text: reply });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-группы' });
      },
      stop: () => undefined,
    }));
    const links = new Map<string, ChatLink>([['чат-группы', LINK]]);
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        stat: () => undefined,
        carryLink: () => undefined,
        cascade: {
          linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
          saveLink: (chatId, link) => void links.set(chatId, link),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
        split: {
          onTriageFinished: () => undefined,
          onChainEnded: (link, outcome) => conveyor.onChainEnded(link, outcome),
          identityOf: () => 'Ветка группы: split/rename.',
          delivers: () => false,
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const turn = async (text: string) => {
    reply = text;
    registry.start('чат-группы', { prompt: 'задание', cwd: CWD }, { projectPath: CWD });
    await new Promise((done) => setTimeout(done, 20));
  };

  it('allowed_warning: ход закрыт, а запись разделения держит очередь до сброса', async () => {
    limit = { resetsAt: RESETS_AT, status: 'allowed_warning' };
    await turn('Переименовал все вызовы.');
    expect(conveyor.view([PARENT])?.groups[0]?.status).toBe('done');
    expect(store.getSplitPlan(PARENT)?.limitUntil).toBe(new Date(RESETS_AT * 1000).toISOString());
    expect(conveyor.view([PARENT])?.limitWarning).toBe(true);
  });

  it('обычное allowed очередь не держит', async () => {
    limit = { resetsAt: RESETS_AT, status: 'allowed' };
    await turn('Переименовал все вызовы.');
    expect(store.getSplitPlan(PARENT)?.limitUntil).toBeUndefined();
  });
});
