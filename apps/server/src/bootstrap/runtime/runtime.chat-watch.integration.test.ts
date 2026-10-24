import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatWatchSignalsResponse } from '@agentdeck/contracts/group-watch';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { registerChatWatchSignalsRoutes } from '../../routes/chat/watch-signals-routes.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Одиночный чат под сторожем (A1) поверх НАСТОЯЩЕЙ сборки: `createRuntime`, маршрут
 * отправки, реестр прогонов, проводка сторожа, хранилище на диске и маршрут сигналов
 * чатов, который читает веб. Подменён только процесс CLI: он трижды падает на одном
 * и том же скрипте и кончает ход.
 */

const CHAT = 'одиночный-чат';
const SESSION = 'sess-solo';

/** Ход CLI: три одинаковых падения одного скрипта, затем конец хода. */
const FAILING_TURN: ChatEvent[] = [1, 2, 3].flatMap((n): ChatEvent[] => [
  { kind: 'tool', id: `t${n}`, name: 'Bash', input: { command: 'node scripts/seed.mjs' } },
  {
    kind: 'toolResult',
    toolUseId: `t${n}`,
    isError: true,
    errorKind: 'exit',
    errorHead: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
  },
]);

describe('сборка: одиночный чат под сторожем — сигнал доходит до маршрута веба', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: RunOptions[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-chat-watch-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(appData);
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
    started = [];
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        started.push(options);
        for (const event of FAILING_TURN) onEvent(event);
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
    registerChatWatchSignalsRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    await removeWhenFree(root);
  });

  async function send(): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt: 'Заполни базу', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    while (runtime.chatRuns.isRunning(CHAT)) await new Promise((done) => setTimeout(done, 20));
  }

  async function signals(): Promise<ChatWatchSignalsResponse> {
    const response = await app.inject({ method: 'GET', url: '/api/chat/watch-signals' });
    expect(response.statusCode).toBe(200);
    return response.json<ChatWatchSignalsResponse>();
  }

  it('три одинаковых падения в чате без связи — R24 под ключом чата, и на диске', async () => {
    await send();
    expect(started).toHaveLength(1);
    const body = await signals();
    expect(Object.keys(body.signals)).toEqual([CHAT]);
    expect(body.signals[CHAT]).toMatchObject([
      {
        rule: 'R24',
        chatId: CHAT,
        numbers: { fails: 3 },
        params: { call: 'node scripts/seed.mjs' },
      },
    ]);
    // Перезапуск панели: срез читается с диска.
    const reloaded = new AppStore(join(root, 'agentdeck'));
    expect(Object.keys(reloaded.getAllChatWatchSignals())).toEqual([CHAT]);
  });

  it('одиночные чаты выключены в настройках — маршрут пуст', async () => {
    store.updateSettings({
      groupWatch: { ...store.getSettings().groupWatch, singleChats: false },
    });
    await send();
    expect(started).toHaveLength(1);
    expect((await signals()).signals).toEqual({});
  });
});
