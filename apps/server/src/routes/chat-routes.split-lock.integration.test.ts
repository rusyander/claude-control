import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { createSplitLauncher, launchFromRecord } from './chat/split-launch.ts';

/**
 * Запуск разделения по кнопке — находки 12 и 19 живого прогона 24.09.2026.
 *
 * 12: при разборе ответ маршрута несёт `chats: []`, кнопка оживала, и второе
 * нажатие заводило второй разбор, затирая запись конвейера, по которой уже шла
 * работа. 19: «Перезапустить» ждал все копии (минуты `npm ci`) и выглядел зависшим.
 *
 * Путь настоящий: маршрут → конвейер → запуск групп → реестр прогонов. Подменены
 * только сам процесс CLI (реестр с заглушкой) и медленная часть запуска копий —
 * воротами перед настоящим `launchFromRecord`.
 */
describe('разделение: замок и перезапуск без ожидания', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let ctx: ServerContext;
  let started: { chatId: string; prompt: string }[];
  /** Ворота запуска копий: закрыты — `launch` ждёт, как ждал бы `npm ci`. */
  let gate: { promise: Promise<void>; open: () => void };

  const ceiling = { model: 'claude-opus-5', effort: 'high' };
  const proposal = {
    shared: 'Общее',
    groups: [
      { title: 'Раз', branch: 'feature/one', tasks: ['первая задача'] },
      { title: 'Два', branch: 'feature/two', tasks: ['вторая задача'] },
    ],
  };

  function makeGate(open: boolean): typeof gate {
    let release = (): void => undefined;
    const promise = open
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          release = resolve;
        });
    return { promise, open: () => release() };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-lock-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-lock-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    started = [];
    gate = makeGate(true);
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({ chatId: options.permissionPrompt?.runId ?? '', prompt: options.prompt });
      },
      stop: () => undefined,
    }));
    store = new AppStore(join(root, 'agentdeck'));
    ctx = {
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
    session = new ChatSession(registry);
  });

  afterEach(() => {
    gate.open();
    registry.stopAll();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  function launchDeps() {
    return {
      runs: registry,
      providerChats: new ProviderChatService(),
      session,
      log: { warn: () => undefined },
    };
  }

  function withConveyor(): SplitConveyor {
    return new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async (record, groups, context, claimBranch): Promise<TaskSplitResult> => {
        await gate.promise;
        return launchFromRecord(ctx, launchDeps(), record, groups, context, claimBranch);
      },
      startTriage: (record, prompt, claim) =>
        createSplitLauncher(ctx, launchDeps(), {
          projectPath: record.projectPath,
          parentChatId: record.parentChatId,
          ...(record.request.model ? { model: record.request.model } : {}),
          ...(record.request.effort ? { effort: record.request.effort } : {}),
        }).startTriage(prompt, claim),
      log: () => undefined,
    });
  }

  async function withRoutes(conveyor: SplitConveyor): Promise<FastifyInstance> {
    const instance = Fastify();
    registerChatSplitRoutes(instance, ctx, { ...launchDeps(), conveyor });
    await instance.ready();
    return instance;
  }

  const split = (instance: FastifyInstance) =>
    instance.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: {
        projectPath: project,
        proposal,
        startRuns: true,
        parentChatId: 'parent-1',
        ...ceiling,
      },
    });

  function finishTriage(conveyor: SplitConveyor, triageId: string): void {
    const block = [
      '```' + SPLIT_PLAN_BLOCK_LANG,
      JSON.stringify({ groups: [{ index: 1 }, { index: 2 }], order: [1, 2] }),
      '```',
    ].join('\n');
    conveyor.onTriageFinished(
      {
        chatId: triageId,
        projectPath: project,
        text: block,
        ok: true,
        startedAt: 1,
        options: { prompt: '', cwd: project },
        contextTokens: 0,
      },
      [triageId],
    );
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
  }

  it('второе «Разделить» при идущем разделении — 409 с кодом, план и разбор те же', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);

    const first = await split(instance);
    expect(first.statusCode).toBe(200);
    const triageId = (first.json() as { triage: { chatId: string } }).triage.chatId;
    const before = store.getSplitPlan('parent-1');
    expect(before?.triageChatId).toBe(triageId);
    const triages = started.length;

    const second = await split(instance);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ messageCode: 'split-plan-running' });
    // Запись не тронута, второго разбора нет.
    expect(store.getSplitPlan('parent-1')?.triageChatId).toBe(triageId);
    expect(store.getSplitPlan('parent-1')?.createdAt).toBe(before?.createdAt);
    expect(started).toHaveLength(triages);

    // Группы закрылись — разделение кончилось, кнопка снова работает.
    const record = store.getSplitPlan('parent-1');
    if (!record) throw new Error('нет записи');
    store.setSplitPlan({
      ...record,
      groups: record.groups.map((group, index) => ({
        ...group,
        status: index === 0 ? 'done' : 'failed',
      })),
    });
    const third = await split(instance);
    await instance.close();
    expect(third.statusCode).toBe(200);
    expect(store.getSplitPlan('parent-1')?.triageChatId).not.toBe(triageId);
  });

  it('перезапуск отвечает 202 сразу; копии заводятся фоном, второй — 409', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const first = await split(instance);
    const triageId = (first.json() as { triage: { chatId: string } }).triage.chatId;
    finishTriage(conveyor, triageId);
    await until(() => started.length >= 3);
    expect(store.getSplitPlan('parent-1')?.groups.map((group) => group.status)).toEqual([
      'started',
      'started',
    ]);

    // Копии теперь «заводятся минутами»: ворота закрыты до конца проверки.
    gate = makeGate(false);
    started.length = 0;
    const timeout = new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 3_000));
    const relaunched = await Promise.race([
      instance.inject({ method: 'POST', url: '/api/chat/split/parent-1/relaunch' }),
      timeout,
    ]);
    if (relaunched === 'timeout') throw new Error('перезапуск ждёт копий — ответа нет за 3 с');
    expect(relaunched.statusCode).toBe(202);
    expect(relaunched.json()).toEqual({ accepted: true });
    // Ход виден в записи ещё до конца запуска: группы уже «стартуют».
    expect(store.getSplitPlan('parent-1')?.groups.map((group) => group.status)).toEqual([
      'started',
      'started',
    ]);
    expect(started).toEqual([]);

    const again = await instance.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/relaunch',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ messageCode: 'split-relaunch-running' });

    gate.open();
    await until(() => started.length >= 2);
    expect(started).toHaveLength(2);

    // Запуск кончился — перезапуск снова доступен.
    await new Promise((done) => setTimeout(done, 50));
    const later = await instance.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/relaunch',
    });
    await instance.close();
    expect(later.statusCode).toBe(202);
  }, 20_000);

  it('перезапуск без разделения — 409 с кодом', async () => {
    const instance = await withRoutes(withConveyor());
    const response = await instance.inject({
      method: 'POST',
      url: '/api/chat/split/nobody/relaunch',
    });
    await instance.close();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ messageCode: 'split-relaunch-nothing' });
  });
});
