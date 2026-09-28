import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SplitOverlapView } from '@agentdeck/contracts/chat-handoff';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { SplitConveyor } from '../../domains/chat/split-conveyor.ts';
import type { SplitOverlap } from '../../domains/chat/split-overlap.ts';
import { TreePause } from '../../domains/chat/tree-pause.ts';
import { appendLoweredRun } from '../../domains/chat/lowered-journal.ts';
import { ProviderChatService } from '../../domains/provider-chat.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerChatRoutes } from '../chat-routes.ts';
import { registerChatHandoffRoutes } from '../chat/handoff-routes.ts';
import { registerChatCascadeRoutes } from '../chat/cascade-routes.ts';
import { registerChatSplitRoutes } from '../chat/split-routes.ts';
import { registerChatTreeRoutes } from '../chat/tree-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from './manage-test-harness.ts';

/**
 * Чат дорожки A на настоящих маршрутах панели: режимы и расход, «Закрыть этап»,
 * подбор модели под задачу, понижённые прогоны, пересечения, приёмка и
 * «Продолжить» оборванных групп разделения. Подменены только процесс CLI
 * (фабрика прогонов реестра), заведение копий групп и сверка веток git
 * (`SplitOverlap.check` — чтение git, её вид приходит готовым). Доказательство —
 * что дошло до процесса (промпт, сессия), хранилище и реестр прогонов.
 */
const SECRET = `ghp_${'Q1w2E3r4'.repeat(4)}`;

describe('panel-agent actions: chat gaps (lane A)', () => {
  let root: string;
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let conveyor: SplitConveyor;
  let h: ManageHarness;
  let started: Array<{ prompt: string; sessionId?: string; allowEdits?: boolean }>;
  let resumed: number[];
  let overlapAsked: string[];
  const ids = { main: randomUUID(), sandbox: randomUUID(), parent: randomUUID() };
  const now = () => new Date().toISOString();

  const seed = (id: string, cwd: string, text: string) => {
    const dir = join(root, 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        sessionId: id,
        cwd,
        timestamp: now(),
        message: { role: 'user', content: text },
      })}\n`,
      'utf8',
    );
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-c-config-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-c-project-'));
    started = [];
    resumed = [];
    overlapAsked = [];
    seed(ids.main, projectDir, 'Почини форму входа');
    const sandboxCwd = join(sandboxRoot(), ids.sandbox);
    seed(ids.sandbox, sandboxCwd, 'Разговор в панели');
    seed(ids.parent, projectDir, 'Родитель разделения');

    store = new AppStore(appData);
    store.addProject({ id: 'p-demo', name: 'Demo', path: projectDir });
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
      backupDir: join(appData, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;

    // Подмена процесса CLI: ход кончается сразу и стоит 0.25 по оценке.
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options: RunOptions, onEvent) => {
        started.push({
          prompt: options.prompt,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        });
        const sessionId = options.sessionId ?? `sess-${started.length}`;
        onEvent({ kind: 'session', sessionId, model: options.model ?? 'm', tools: 0 });
        onEvent({ kind: 'done', costUsd: 0.25, durationMs: 1, sessionId });
        return Promise.resolve();
      },
      stop: () => undefined,
    }));
    const session = new ChatSession(registry);
    const treePause = new TreePause({
      links: () => store.getChatLinks(),
      runs: registry,
      store: {
        get: (key) => store.getTreePause(key),
        all: () => store.getTreePauses(),
        set: (record) => store.setTreePause(record),
        clear: (key) => store.clearTreePause(key),
      },
    });
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (keys) => store.findSplitPlanByTriage(keys),
        all: () => store.getSplitPlans(),
      },
      launch: async (record, groups): Promise<TaskSplitResult> => ({
        chats: groups.map((index) => {
          const chatId = `group-${ids.parent}-${index}`;
          const branch = record.groups[index]?.branch ?? '';
          store.setChatLink(chatId, {
            parentChatId: record.parentChatId,
            createdAt: now(),
            branch,
            groupIndex: index,
            stage: 'work',
          });
          return {
            index,
            title: record.groups[index]?.title ?? '',
            branch,
            chatId,
            path: join(projectDir, `copy-${index}`),
            isWorktree: true,
            started: true,
            prompt: 'работа',
          };
        }),
        failures: [],
      }),
      startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
      parallel: () => 5,
      resume: (group) => {
        resumed.push(group.index);
        return 'sent';
      },
      log: () => undefined,
    });
    const overlapView: SplitOverlapView = {
      at: now(),
      files: [{ path: `src/login.ts`, groups: [0, 1], outside: [1] }],
      mergeOrder: [0, 1],
      counted: [
        { index: 0, files: 2, names: ['src/login.ts', `notes-${SECRET}.md`] },
        { index: 1, files: 1 },
      ],
      unread: [],
    };
    const overlap = {
      check: async (parent: string) => {
        overlapAsked.push(parent);
        return parent === ids.parent ? overlapView : undefined;
      },
    } as unknown as SplitOverlap;

    h = await manageHarness(ctx, (app) => {
      registerConfigRoutes(app, ctx);
      registerProjectRoutes(app, ctx);
      registerChatRoutes(app, ctx, registry, session);
      registerChatHandoffRoutes(app, ctx, {
        runs: registry,
        chains: new HandoffChains(),
        providerChats: new ProviderChatService(),
        session,
      });
      registerChatCascadeRoutes(app, ctx);
      registerChatSplitRoutes(app, ctx, {
        runs: registry,
        providerChats: new ProviderChatService(),
        session,
        gate: treePause,
        conveyor,
        overlap,
      });
      registerChatTreeRoutes(app, ctx, treePause, (keys) => conveyor.view(keys));
    });
  });

  afterEach(async () => {
    registry.stopAll();
    await h.close();
    for (const dir of [root, projectDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const id of Object.values(ids)) {
      rmSync(join(sandboxRoot(), id), { recursive: true, force: true });
    }
  });

  const human = (method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) =>
    h.app.inject({ method, url, headers: { origin: HARNESS_ORIGIN }, payload });

  it('read_chat_modes: auto mode and the stage chain as the menu shows them; unknown chat refused', async () => {
    const before = await h.call('read_chat_modes', { chat: ids.main });
    expect(before.outcome, before.message).toBe('done');
    expect(before.result).toMatchObject({
      chat: ids.main,
      autoMode: { chosenInThisChat: false },
      stageChain: { autoContinue: false, depth: 0 },
    });
    // Человек включил автопродолжение этапа — чтение видит то, что записал маршрут.
    expect(
      (await human('POST', '/api/chat/handoff/auto', { chatId: ids.main, enabled: true }))
        .statusCode,
    ).toBe(200);
    const after = await h.call('read_chat_modes', { chat: ids.main });
    expect(after.result).toMatchObject({ stageChain: { autoContinue: true } });

    const missing = await h.call('read_chat_modes', { chat: 'нет такого чата' });
    expect(missing.outcome).toBe('failed');
  });

  it('request_chat_handoff: the standard request reaches the CLI in the same session only by approval; panel chat refused', async () => {
    const rejected = await h.decided('request_chat_handoff', { chat: ids.main }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(started).toEqual([]);

    const { card, result } = await h.decided('request_chat_handoff', { chat: ids.main });
    expect(card).toMatchObject({ name: 'request_chat_handoff', risk: 'danger' });
    expect(JSON.stringify(card.preview)).not.toContain('Close the current stage');
    expect(result.outcome, result.message).toBe('done');
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toMatch(/^Close the current stage/);
    expect(started[0]?.sessionId).toBe(ids.main);

    const sandbox = await h.call('request_chat_handoff', { chat: ids.sandbox });
    expect(sandbox.outcome).toBe('failed');
    expect(started).toHaveLength(1);

    // Расход сеанса считает тот же реестр: один ход по 0.25.
    const spend = await h.call('read_chat_spend', {});
    expect(spend.outcome, spend.message).toBe('done');
    expect(spend.result).toMatchObject({ estimatedCostUsd: 0.25 });
  });

  it('read_model_cascade / set_model_cascade: the switch changes only by approval; same state and foreign folder refused', async () => {
    const read = await h.call('read_model_cascade', { project: projectDir });
    expect(read.outcome, read.message).toBe('done');
    const initial = (read.result as { enabled: boolean }).enabled;

    const rejected = await h.decided(
      'set_model_cascade',
      { project: 'p-demo', enabled: !initial },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect((await h.call('read_model_cascade', { project: 'p-demo' })).result).toMatchObject({
      enabled: initial,
    });

    const { card, result } = await h.decided('set_model_cascade', {
      project: 'p-demo',
      enabled: !initial,
    });
    expect(card.preview.summaryCode).toBe(
      initial ? 'summary-set-model-cascade-off' : 'summary-set-model-cascade-on',
    );
    expect(result.outcome, result.message).toBe('done');
    const stored = await h.app.inject({
      method: 'GET',
      url: `/api/chat/cascade?path=${encodeURIComponent(projectDir)}`,
    });
    expect(stored.json()).toMatchObject({ enabled: !initial });

    const same = await h.call('set_model_cascade', { project: 'p-demo', enabled: !initial });
    expect(same.outcome).toBe('failed');
    expect(same.message).toContain('Nothing would change');

    const foreign = await h.call('set_model_cascade', { project: root, enabled: true });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
  });

  it('list_lowered_runs: summary and newest runs first, check commands masked', async () => {
    for (const [index, ok] of [true, false, true].entries()) {
      appendLoweredRun(appData, {
        chatId: `chat-${index}`,
        projectPath: projectDir,
        model: 'claude-haiku',
        effort: 'low',
        kind: 'docs',
        startedAt: 1_000 * index,
        finishedAt: 1_000 * index + 5_000,
        ok,
        checks: ok ? [`pnpm test --token=${SECRET}`] : [],
        tokens: 100,
      });
    }
    const out = await h.call('list_lowered_runs', { limit: 2 });
    expect(out.outcome, out.message).toBe('done');
    const view = out.result as {
      summary: { total: number; failed: number };
      total: number;
      runs: Array<{ chatId: string }>;
    };
    expect(view.summary).toMatchObject({ total: 3, failed: 1 });
    expect(view.runs.map((run) => run.chatId)).toEqual(['chat-2', 'chat-1']);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect((await h.call('list_lowered_runs', { limit: 0 })).outcome).toBe('invalid');
  });

  describe('split plan', () => {
    beforeEach(async () => {
      await conveyor.begin({
        parentChatId: ids.parent,
        projectPath: projectDir,
        proposal: {
          groups: [
            { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
            { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
          ],
        },
        request: {},
      });
      conveyor.onTriageFinished(
        {
          chatId: 'triage',
          projectPath: projectDir,
          ok: true,
          startedAt: 1,
          text: [
            '```' + SPLIT_PLAN_BLOCK_LANG,
            JSON.stringify({ groups: [], order: [0, 1] }),
            '```',
          ].join('\n'),
        } as Parameters<SplitConveyor['onTriageFinished']>[0],
        ['triage'],
      );
      await new Promise((done) => setTimeout(done, 30));
      // Группа 0 доставлена, процесс группы 1 умер посреди хода.
      const record = store.getSplitPlan(ids.parent)!;
      record.groups[0]!.status = 'done';
      record.groups[1]!.status = 'awaiting';
      record.groups[1]!.waitingFor = 'interrupted';
      record.groups[1]!.interruptedAt = now();
      store.setSplitPlan(record);
    });

    const group = (index: number) => store.getSplitPlan(ids.parent)?.groups[index];

    it('read_split_overlap: files of two groups and merge order, secrets masked; chat without a plan refused', async () => {
      const out = await h.call('read_split_overlap', { chat: ids.parent });
      expect(out.outcome, out.message).toBe('done');
      expect(out.result).toMatchObject({
        files: [{ path: 'src/login.ts', groups: [0, 1], outside: [1] }],
        mergeOrder: [0, 1],
        groups: { 0: 'Раз', 1: 'Два' },
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(overlapAsked).toEqual([ids.parent]);

      const none = await h.call('read_split_overlap', { chat: ids.main });
      expect(none.outcome).toBe('failed');
      expect(none.message).toContain('no split plan');
    });

    it('split_accept_group: delivered group accepted and unaccepted by approval; undelivered refused before a card', async () => {
      const notDone = await h.call('split_accept_group', { chat: ids.parent, group: 1 });
      expect(notDone.outcome).toBe('failed');
      expect(notDone.message).toContain('not delivered');

      const rejected = await h.decided(
        'split_accept_group',
        { chat: ids.parent, group: 'Раз' },
        'reject',
      );
      expect(rejected.result.outcome).toBe('rejected');
      expect(group(0)?.acceptedAt).toBeUndefined();

      const accepted = await h.decided('split_accept_group', { chat: ids.parent, group: 'Раз' });
      expect(accepted.card.preview.summaryCode).toBe('summary-split-accept');
      expect(accepted.result.outcome, accepted.result.message).toBe('done');
      expect(group(0)?.acceptedAt).toBeTruthy();

      const again = await h.call('split_accept_group', { chat: ids.parent, group: 0 });
      expect(again.outcome).toBe('failed');
      expect(again.message).toContain('Nothing would change');

      const unaccepted = await h.decided('split_accept_group', {
        chat: ids.parent,
        group: 0,
        accepted: false,
      });
      expect(unaccepted.card.preview.summaryCode).toBe('summary-split-unaccept');
      expect(group(0)?.acceptedAt).toBeUndefined();
    });

    it('split_resume_interrupted: only interrupted groups resume, by approval; a delivered group is refused', async () => {
      const delivered = await h.call('split_resume_interrupted', { chat: ids.parent, group: 0 });
      expect(delivered.outcome).toBe('failed');
      expect(delivered.message).toContain('was not interrupted');

      const rejected = await h.decided('split_resume_interrupted', { chat: ids.parent }, 'reject');
      expect(rejected.result.outcome).toBe('rejected');
      expect(resumed).toEqual([]);

      const { card, result } = await h.decided('split_resume_interrupted', { chat: ids.parent });
      expect(
        card.preview.fields.find((field) => field.labelCode === 'label-split-interrupted-groups')
          ?.value,
      ).toBe('1 — Два');
      expect(result.outcome, result.message).toBe('done');
      expect(result.result).toMatchObject({ resumed: [1], refused: [] });
      expect(resumed).toEqual([1]);
    });
  });
});
