import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { groupSignalsOf } from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * F-54 на сборке: «Остановить всё» — пауза группы для сторожа, и время паузы
 * берётся из записи дерева, а не с первого раза, когда сторож её увидел. Поверх
 * НАСТОЯЩЕЙ сборки (`createRuntime`, реестр, проводка сторожа, хранилище на диске);
 * подменён только процесс CLI: группа на стоящем дереве делает коммит.
 */

const PARENT = 'родитель-пауза-дерева';
const CHILD = 'чат-группы-на-паузе';
const SESSION = 'sess-tree-paused';

const SPLIT = {
  parentChatId: PARENT,
  projectPath: '',
  createdAt: '2026-10-23T00:00:00.000Z',
  order: [0],
  request: { allowEdits: true },
  proposal: { groups: [{ title: 'UI', tasks: ['PROJ-7'] }] },
  groups: [
    { index: 0, title: 'UI', branch: 'feat/ui', after: [], status: 'running', chatId: CHILD },
  ],
} as unknown as SplitPlanRecord;

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-10-23T00:00:00.000Z',
  branch: 'feat/ui',
  groupIndex: 0,
  stage: 'work',
};

describe('сборка: «Остановить всё» — время паузы дерева доходит до сторожа (F-54)', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-tree-watch-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
    store.setSplitPlan({ ...structuredClone(SPLIT), projectPath: project });
    store.setChatLink(CHILD, LINK);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
    const fake = (): RunLike => ({
      start: async (_options: RunOptions, onEvent) => {
        onEvent({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'git commit -m x' } });
        onEvent({ kind: 'toolResult', toolUseId: 't1', chars: 10 });
        onEvent({ kind: 'text', text: 'Закоммитил.' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: SESSION });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
    app = Fastify();
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    await removeWhenFree(root);
  });

  it('дерево встало 10 мин назад, группа коммитит — R20 (время паузы из записи дерева)', async () => {
    // Ход, который пауза не сняла (`unconfirmed`): дерево стоит, а группа действует.
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    store.setTreePause({ root: PARENT, at, chats: {}, pendingStarts: [] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHILD, prompt: 'Продолжай', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 300));
    const rules = groupSignalsOf(store.getGroupWatchSignals(PARENT, 0)).map((item) => item.rule);
    expect(rules).toContain('R20');
  });

  // Живой прогон 25.10, группа #3: «Продолжить» после паузы в 35 ч — и R20 «группа на паузе, а сессия
  // действует» на первом же вызове. Сторож снимал состояние группы на старте хода раньше, чем конвейер
  // переводил её в «стартует», и держал снятое до ближайшего обхода.
  it('продолжение группы с паузы — первый вызов хода не R20', async () => {
    const pausedAt = new Date(Date.now() - 35 * 3_600_000).toISOString();
    const plan = structuredClone(SPLIT);
    plan.groups[0] = { ...plan.groups[0], status: 'paused', pausedAt } as (typeof plan.groups)[0];
    store.setSplitPlan({ ...plan, projectPath: project });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHILD, prompt: 'Продолжай', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 300));
    // Ход прошёл целиком (поддельный CLI сразу кончает) — группа уже не на паузе.
    expect(store.getSplitPlan(PARENT)?.groups[0]?.status).not.toBe('paused');
    const rules = groupSignalsOf(store.getGroupWatchSignals(PARENT, 0)).map((item) => item.rule);
    expect(rules).not.toContain('R20');
  });
});
