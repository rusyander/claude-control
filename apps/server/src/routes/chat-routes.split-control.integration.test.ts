import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { registerChatRunRoutes } from './chat/run-routes.ts';
import { pauseOnHumanStop } from './chat/split-control-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';

/**
 * Управление группой из хаба по HTTP (журнал 81, 89): пауза останавливает
 * прогон и отдаёт место очереди, «Продолжить» и «Запустить сейчас» упираются в
 * потолок с числами и проходят с согласием, «Стоп» в чате группы — та же пауза.
 *
 * Путь настоящий: маршрут → конвейер → реестр прогонов → хранилище на диске.
 * Подменены только процесс CLI (прогон, который идёт, пока его не остановят) и
 * заведение копий git — группа запускается прямо в реестре.
 */
describe('разделение: пауза, продолжение, запуск сейчас — по HTTP', () => {
  let root: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let conveyor: SplitConveyor;
  let app: FastifyInstance;
  let resumed: { index: number; prompt: string }[];
  const PARENT = 'родитель';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-control-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    resumed = [];
    registry = new ChatRunRegistry((): RunLike => {
      let finish = (): void => undefined;
      return {
        start: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        stop: () => finish(),
      };
    });
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'agentdeck'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async (record, groups): Promise<TaskSplitResult> => ({
        chats: groups.map((index) => {
          const chatId = `chat-${index}`;
          const branch = record.groups[index]?.branch ?? '';
          store.setChatLink(chatId, {
            parentChatId: record.parentChatId,
            createdAt: new Date().toISOString(),
            branch,
            groupIndex: index,
            stage: 'work',
          });
          const started = registry.start(chatId, { prompt: 'работа', cwd: root }, {});
          return {
            index,
            title: record.groups[index]?.title ?? '',
            branch,
            chatId,
            path: join(root, `copy-${index}`),
            isWorktree: true,
            started,
            prompt: 'работа',
          };
        }),
        failures: [],
      }),
      startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
      parallel: () => 1,
      resume: (group, prompt) => {
        resumed.push({ index: group.index, prompt });
        return 'sent';
      },
      log: () => undefined,
    });
    registry.setHumanStopListener(pauseOnHumanStop(store, conveyor));
    const session = new ChatSession(registry);
    app = Fastify();
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      conveyor,
    });
    registerChatRunRoutes(app, ctx, registry, session);
    await app.ready();

    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: root,
      proposal: {
        groups: [
          { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
          { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
          { title: 'Три', branch: 'feature/three', tasks: ['третья'] },
        ],
      },
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await settle();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const group = (index: number) => store.getSplitPlan(PARENT)?.groups[index];
  const post = (path: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/chat/split/${encodeURIComponent(PARENT)}/${path}`,
      payload,
    });

  it('пауза: прогон остановлен, группа на паузе, место ушло следующей из очереди', async () => {
    expect(registry.isRunning('chat-0')).toBe(true);
    expect(group(1)?.status).toBe('pending');

    const res = await post('pause', { index: 0 });
    await settle();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ index: 0, stopped: 1 });
    expect(registry.isRunning('chat-0')).toBe(false);
    expect(group(0)?.status).toBe('paused');
    expect(group(1)?.status).toBe('started');
    expect(registry.isRunning('chat-1')).toBe(true);
  });

  it('«Продолжить» при полном потолке — 409 с числами; с согласием — продолжение', async () => {
    await post('pause', { index: 0 });
    await settle();

    const refused = await post('resume-paused', { index: 0 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      messageCode: 'split-group-no-slot',
      params: { running: '1', limit: '1' },
    });
    expect(resumed).toEqual([]);

    const forced = await post('resume-paused', { index: 0, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ index: 0, outcome: 'sent' });
    expect(resumed[0]?.index).toBe(0);
  });

  it('«Запустить сейчас» третью мимо второй: 409 без согласия, старт с ним', async () => {
    const refused = await post('start-now', { index: 2 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ messageCode: 'split-group-no-slot' });

    const forced = await post('start-now', { index: 2, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().chats.map((chat: { index: number }) => chat.index)).toEqual([2]);
    expect(registry.isRunning('chat-2')).toBe(true);
    expect(group(1)?.status).toBe('pending');
  });

  it('«Стоп» в чате группы — пауза группы, а не сбой', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/chat/chat-0/stop' });
    await settle();
    expect(res.json()).toEqual({ ok: true });
    expect(group(0)?.status).toBe('paused');
    expect(group(1)?.status).toBe('started');
  });

  it('номер не тот — 400; группа не в том состоянии — 409 с кодом', async () => {
    expect((await post('pause', { index: -1 })).statusCode).toBe(400);
    const notQueued = await post('start-now', { index: 0 });
    expect(notQueued.statusCode).toBe(409);
    expect(notQueued.json()).toMatchObject({ messageCode: 'split-start-not-queued' });
  });
});
