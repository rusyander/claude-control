import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { createHandoffPlanner } from '../chat/handoff-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

/**
 * Группа в режиме «вопросы — человеку» (не «по плану») кончила ход ожиданием,
 * написанным словами без «?» (живой случай RBAC 23.10: «Этапы D и E начну после
 * ответа. Вопросы и рекомендации записаны в PROGRESS.md»). `pausedTurn` и итог
 * группы читали только `endsWithQuestion`: ход считался итогом, группа — «готово»,
 * ждавшие стартовали от недоделанной ветки, а у группы с доставкой шла сверка и
 * напоминания «откройте MR» вместо ответа человека.
 *
 * Путь настоящий: реестр прогонов, планировщик цепочки, `chainOutcomeOf`,
 * конвейер и хранилище плана. Подменён только процесс CLI.
 */

const CWD = 'C:/work/проект-worktrees/rbac';
const PARENT = 'родитель';
const WAIT =
  'Сделал этапы A–C: роли и проверки прав.\n\n' +
  'Этапы D и E начну после ответа. Вопросы и рекомендации записаны в .agent/PROGRESS.md';

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-10-23T10:00:00.000Z',
  title: 'RBAC',
  branch: 'split/rbac',
  groupIndex: 0,
  stage: 'fix',
};

describe('группа «вопросы человеку»: ожидание ответа словами — пауза, не итог', () => {
  let root: string;
  let store: AppStore;
  let conveyor: SplitConveyor;
  let registry: ChatRunRegistry;
  let reply: string;
  let starts: string[];
  let checks: number;
  let nudges: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-prose-wait-'));
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
          title: 'RBAC',
          branch: 'split/rbac',
          after: [],
          status: 'started',
          chatId: 'чат-группы',
          path: CWD,
          deliver: true,
        },
      ],
    });
    checks = 0;
    nudges = 0;
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
      delivery: {
        facts: async () => {
          checks += 1;
          return { missing: ['нет MR'], head: 'h1' };
        },
        nudge: () => {
          nudges += 1;
          return 'sent';
        },
      },
    });

    reply = '';
    starts = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options, onEvent) => {
        starts.push(options.prompt ?? '');
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
          identityOf: () => 'Ветка группы: split/rbac.',
          delivers: () => true,
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
    await new Promise((done) => setTimeout(done, 30));
  };
  const group = () => conveyor.view([PARENT])?.groups[0];

  it('«начну после ответа» — группа ждёт ответа, звена и сверки доставки нет', async () => {
    await turn(WAIT);

    expect(group()?.status).toBe('awaiting');
    expect(group()?.waitingFor).toBe('question');
    // Ни звена доставки, ни сверки git: ход — вопрос человеку, а не итог.
    expect(starts).toEqual(['задание']);
    expect(checks).toBe(0);
    expect(nudges).toBe(0);
  });

  it('метка HUMAN: с «once you confirm» — по-прежнему стоп доставки, не вопрос', async () => {
    await turn(
      'Ветка готова.\n\nHUMAN: merge — MR !12 must land first. Once you confirm I will push.',
    );
    await new Promise((done) => setTimeout(done, 30));

    expect(group()?.waitingFor).not.toBe('question');
    expect(checks).toBeGreaterThan(0);
  });

  it('отчёт без ожидания — итог, как раньше', async () => {
    await turn('Сделал этапы A–E, проверки зелёные.');

    expect(group()?.waitingFor).not.toBe('question');
  });
});
