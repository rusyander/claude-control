import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import { createSplitLauncher, launchFromRecord } from './chat/split-launch.ts';
import { LiveSession } from '../domains/chat/live-session.ts';
import type { TransportOpener } from '../domains/chat/live-transport.ts';
import { hasParentLink, PendingAsks } from '../domains/chat/pending-asks.ts';

/** Транспорт CLI в памяти: конец ввода закрывает «процесс», как дочитавший stdin CLI. */
const memoryCli: TransportOpener = (_launch, handlers) => ({
  pid: 1,
  write: () => undefined,
  end: () => void setTimeout(() => handlers.close(0), 5),
  kill: () => handlers.close(1),
  detach: () => undefined,
});

/**
 * «Отменить план» и замок «Разделить» (W3-5, владелец 25.09.2026).
 *
 * Идущий план держал «Разделить» запертой до конца последней группы, а «только
 * завести чаты» замок обходило. Теперь: тот же 409 для обоих путей с ключом
 * плана, а явная отмена закрывает группы, оставляя чаты и ветки, и снимает
 * замок. Отменённый план не оживает ни итогом разбора, ни прогоном в чате группы.
 *
 * Путь настоящий: маршрут → конвейер → запуск групп → реестр прогонов;
 * подменён только процесс CLI.
 */
describe('разделение: отмена плана', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let ctx: ServerContext;
  let started: { chatId: string; prompt: string }[];
  /** Ворота запуска копий: закрыты — `launch` ждёт, как ждал бы `npm ci`. */
  let gate: { promise: Promise<void>; open: () => void };
  /** Прогоны висят до остановки — как идущий ход агента. */
  let hang: boolean;

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
    hang = false;
    registry = new ChatRunRegistry((): RunLike => {
      let release = (): void => undefined;
      return {
        start: async (options) => {
          started.push({ chatId: options.permissionPrompt?.runId ?? '', prompt: options.prompt });
          if (hang) await new Promise<void>((done) => (release = done));
        },
        stop: () => release(),
      };
    });
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

  async function triageStarted(instance: FastifyInstance): Promise<string> {
    const first = await split(instance);
    expect(first.statusCode).toBe(200);
    return (first.json() as { triage: { chatId: string } }).triage.chatId;
  }

  const cancel = (instance: FastifyInstance, parent = 'parent-1') =>
    instance.inject({ method: 'POST', url: `/api/chat/split/${parent}/cancel` });

  const statuses = () => store.getSplitPlan('parent-1')?.groups.map((group) => group.status);

  it('«только завести чаты» при идущем плане — тот же 409 с ключом плана', async () => {
    const instance = await withRoutes(withConveyor());
    await triageStarted(instance);
    const before = started.length;

    const createOnly = await instance.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: false, parentChatId: 'parent-1' },
    });
    await instance.close();

    expect(createOnly.statusCode).toBe(409);
    expect(createOnly.json()).toMatchObject({
      messageCode: 'split-plan-running',
      parentChatId: 'parent-1',
    });
    expect(started).toHaveLength(before);
  });

  it('«Отменить план»: группы закрыты с причиной, отметка в записи, новое «Разделить» проходит', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const triageId = await triageStarted(instance);
    // Ходы групп идут, пока их не остановят: счётчик `stopped` — про них.
    hang = true;
    finishTriage(conveyor, triageId);
    await until(() => started.length >= 3);
    expect(statuses()).toEqual(['started', 'started']);
    const groupChats = started.slice(1).map((run) => run.chatId);
    await until(() => groupChats.every((chatId) => registry.isRunning(chatId)));

    const response = await cancel(instance);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { stopped: number; cancelled: number; chatIds: string[] };
    expect(body.cancelled).toBe(2);
    expect(body.stopped).toBe(2);
    // По ним вкладка гасит свою очередь дописанного (F3).
    expect([...body.chatIds].sort()).toEqual([...groupChats].sort());
    expect(groupChats.filter((chatId) => registry.isRunning(chatId))).toEqual([]);
    hang = false;

    const record = store.getSplitPlan('parent-1');
    expect(record?.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(statuses()).toEqual(['failed', 'failed']);
    expect(record?.groups.map((group) => group.error)).toEqual([
      'план отменён человеком',
      'план отменён человеком',
    ]);
    // Чаты групп не удалены: связи на месте.
    const linked = Object.values(store.getChatLinks()).filter(
      (link) => link.parentChatId === 'parent-1',
    );
    expect(linked.length).toBeGreaterThanOrEqual(2);

    // Замок снят — разделить можно заново, и это новый план.
    const again = await split(instance);
    await instance.close();
    expect(again.statusCode).toBe(200);
    expect(store.getSplitPlan('parent-1')?.cancelledAt).toBeUndefined();
  }, 20_000);

  // F4c: процесс CLI, ждущий следующего хода в копии группы, держал её после
  // отмены, и «Убрать копию» спотыкалась. Процессы в самом проекте (родитель,
  // группа без копии) отмена не трогает.
  it('отмена закрывает простаивающие CLI в копиях групп, но не в проекте', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const triageId = await triageStarted(instance);
    finishTriage(conveyor, triageId);
    await until(() => statuses()?.every((status) => status === 'started') ?? false);
    const copyDir = mkdtempSync(join(tmpdir(), 'cc-split-lock-copy-'));
    const record = store.getSplitPlan('parent-1')!;
    record.groups[0]!.path = copyDir;
    record.groups[1]!.path = project;
    store.setSplitPlan(record);
    const pooled = (id: string, cwd: string): LiveSession => {
      const live = new LiveSession(
        { command: 'cli', args: [], cwd, env: {}, shell: false, signature: 's' },
        Date.now,
        memoryCli,
      );
      live.sessionId = id;
      registry.livePool.keep(live);
      return live;
    };
    const inCopy = pooled('in-copy', copyDir);
    const inProject = pooled('in-project', project);

    const response = await cancel(instance);
    await instance.close();
    await until(() => !inCopy.alive);
    rmSync(copyDir, { recursive: true, force: true });

    expect(response.statusCode).toBe(200);
    expect(inCopy.alive).toBe(false);
    expect(inProject.alive).toBe(true);
    registry.livePool.closeAll();
  }, 20_000);

  // Живой прогон 26.09: после отмены плана вкладка всё ещё звала «агент ждёт
  // ответа» по группе, кончившей ход вопросом, — запись вопроса переживала план.
  it('отмена снимает записанные вопросы групп — «ждёт ответа» больше не зовёт', async () => {
    const conveyor = withConveyor();
    const asks = new PendingAsks({
      isTreeChat: hasParentLink((key) => store.getChatLink(key)),
    });
    const instance = Fastify();
    registerChatSplitRoutes(instance, ctx, { ...launchDeps(), conveyor, asks });
    await instance.ready();
    const triageId = await triageStarted(instance);
    finishTriage(conveyor, triageId);
    await until(
      () => store.getSplitPlan('parent-1')?.groups.every((group) => group.chatId) ?? false,
    );
    const [asking, quiet] = store.getSplitPlan('parent-1')!.groups.map((group) => group.chatId!);
    asks.finished({
      chatId: asking!,
      sessionId: `sess-${asking}`,
      text: 'Сделал половину.\n\nКакой формат выбрать?',
      ok: true,
      startedAt: 0,
      options: { prompt: '', cwd: project },
      contextTokens: 0,
    });
    // Вопрос чужого дерева отмена этого плана не трогает.
    store.setChatLink('other-child', {
      parentChatId: 'other',
      createdAt: '2026-09-26T00:00:00.000Z',
    });
    asks.finished({
      chatId: 'other-child',
      text: 'Какую ветку взять?',
      ok: true,
      startedAt: 0,
      options: { prompt: '', cwd: project },
      contextTokens: 0,
    });
    expect(asks.of([`sess-${asking}`], () => false)).toHaveLength(1);

    const response = await cancel(instance);
    await instance.close();

    expect(response.statusCode).toBe(200);
    expect(asks.of([asking!, `sess-${asking}`], () => false)).toEqual([]);
    expect(asks.of([quiet!], () => false)).toEqual([]);
    expect(asks.of(['other-child'], () => false)).toHaveLength(1);
  }, 20_000);

  it('отменять нечего — 409 с кодом, и на чужом ключе, и на отменённом плане', async () => {
    const instance = await withRoutes(withConveyor());
    // Плана не было вовсе — это не «уже закончилось» (D7).
    const nobody = await cancel(instance, 'nobody');
    expect(nobody.statusCode).toBe(409);
    expect(nobody.json()).toMatchObject({ messageCode: 'split-plan-cancel-unknown' });

    await triageStarted(instance);
    expect((await cancel(instance)).statusCode).toBe(200);
    const twice = await cancel(instance);
    await instance.close();
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ messageCode: 'split-plan-cancel-nothing' });
  });

  it('отменённый план не оживает ни перезапуском, ни «Продолжить» (m1, D6)', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const triageId = await triageStarted(instance);
    finishTriage(conveyor, triageId);
    await until(() => started.length >= 3);
    expect((await cancel(instance)).statusCode).toBe(200);
    const before = started.length;

    const relaunch = await instance.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/relaunch',
    });
    const resume = await instance.inject({
      method: 'POST',
      url: '/api/chat/split/parent-1/resume',
      payload: {},
    });
    await new Promise((done) => setTimeout(done, 100));
    await instance.close();

    expect(relaunch.statusCode).toBe(409);
    expect(relaunch.json()).toMatchObject({ messageCode: 'split-plan-cancelled' });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toMatchObject({ messageCode: 'split-plan-cancelled' });
    // Группы как были закрыты, так и остались; новых прогонов нет.
    expect(statuses()).toEqual(['failed', 'failed']);
    expect(store.getSplitPlan('parent-1')?.cancelledAt).toBeDefined();
    expect(started).toHaveLength(before);
    // И сам конвейер не перезапускает отменённый план, кто бы его ни звал.
    await expect(conveyor.relaunch('parent-1', project, () => undefined)).rejects.toMatchObject({
      messageCode: 'split-plan-cancelled',
    });
  }, 20_000);

  it('перезапуск гасит и прогон группы у чужого CLI, а не только у Claude (m2)', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const triageId = await triageStarted(instance);
    finishTriage(conveyor, triageId);
    await until(() => started.length >= 3);
    const record = store.getSplitPlan('parent-1');
    if (!record) throw new Error('нет записи');
    store.setSplitPlan({
      ...record,
      groups: record.groups.map((group, index) =>
        index === 0 ? { ...group, chatId: foreignChatKey('codex', 'foreign-0') } : group,
      ),
    });
    const stop = vi.spyOn(ProviderChatService.prototype, 'stop').mockReturnValue(true);
    // Копии новой жизни ждут за воротами: проверяем только, что погашено.
    gate = makeGate(false);
    try {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/chat/split/parent-1/relaunch',
      });
      expect(response.statusCode).toBe(202);
      expect(stop).toHaveBeenCalledWith('foreign-0');
    } finally {
      stop.mockRestore();
      gate.open();
      await new Promise((done) => setTimeout(done, 100));
      await instance.close();
    }
  }, 20_000);

  it('отменённый план не оживает: ни итогом разбора, ни продолжением чата группы', async () => {
    const conveyor = withConveyor();
    const instance = await withRoutes(conveyor);
    const triageId = await triageStarted(instance);

    // Отмена во время разбора: его итог приходит позже и групп заводить не должен.
    expect((await cancel(instance)).statusCode).toBe(200);
    const before = started.length;
    finishTriage(conveyor, triageId);
    await new Promise((done) => setTimeout(done, 100));
    expect(started).toHaveLength(before);
    expect(statuses()).toEqual(['failed', 'failed']);

    // Прогон в чате бывшей группы — обычный разговор, не «группа снова идёт».
    const record = store.getSplitPlan('parent-1');
    if (!record) throw new Error('нет записи');
    store.setSplitPlan({
      ...record,
      groups: record.groups.map((group, index) => ({ ...group, chatId: `g-${index}` })),
    });
    store.setChatLink('g-0', {
      parentChatId: 'parent-1',
      groupIndex: 0,
      stage: 'work',
      createdAt: new Date().toISOString(),
    });
    const link = store.getChatLink('g-0');
    if (!link) throw new Error('нет связи');
    conveyor.onChainResumed(link, 'g-0');
    await instance.close();
    expect(statuses()).toEqual(['failed', 'failed']);

    // Замок снят: splitPlanRunning по отменённому плану — «не идёт».
    const again = await withRoutes(conveyor);
    const next = await split(again);
    await again.close();
    expect(next.statusCode).toBe(200);
  }, 20_000);
});
