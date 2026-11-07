import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../../domains/chat/run-options/run-options.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { sandboxRoot } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { TreePause } from '../../../domains/chat/tree-pause/tree-pause.ts';
import { appendLoweredRun } from '../../../domains/chat/lowered-journal/lowered-journal.ts';
import { registerConfigRoutes } from '../../config-routes/config-routes.ts';
import { registerProjectRoutes } from '../../project-routes/project-routes.ts';
import { registerChatRoutes } from '../../chat-routes/chat-routes.ts';
import { registerChatHandoffRoutes } from '../../chat/handoff-routes.ts';
import { registerChatCascadeRoutes } from '../../chat/cascade-routes.ts';
import { registerChatTreeRoutes } from '../../chat/tree-routes/tree-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * Чат дорожки A на настоящих маршрутах панели: режимы и расход, «Закрыть этап»,
 * подбор модели под задачу, понижённые прогоны. Подменён только процесс CLI
 * (фабрика прогонов реестра). Групп разделения нет с этапа 10: пересечения,
 * приёмка и «Продолжить» групп ушли вместе с ними. Доказательство —
 * что дошло до процесса (промпт, сессия), хранилище и реестр прогонов.
 */
const SECRET = `ghp_${'Q1w2E3r4'.repeat(4)}`;

describe('panel-agent actions: chat gaps (lane A)', () => {
  let root: string;
  let appData: string;
  let projectDir: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let h: ManageHarness;
  let started: Array<{ prompt: string; sessionId?: string; allowEdits?: boolean }>;
  const ids = { main: randomUUID(), sandbox: randomUUID() };
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
    seed(ids.main, projectDir, 'Почини форму входа');
    const sandboxCwd = join(sandboxRoot(), ids.sandbox);
    seed(ids.sandbox, sandboxCwd, 'Разговор в панели');

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
    h = await manageHarness(ctx, (app) => {
      registerConfigRoutes(app, ctx);
      registerProjectRoutes(app, ctx);
      registerChatRoutes(app, ctx, registry, session);
      registerChatHandoffRoutes(app, ctx, {
        runs: registry,
        chains: new HandoffChains(),
        session,
      });
      registerChatCascadeRoutes(app, ctx);
      registerChatTreeRoutes(app, ctx, treePause);
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

  /**
   * «Подбирать модель под задачу» и «Ревью после работы» сняты с меню чата (этап 10,
   * G14): действий агента и маршрута правила больше нет — агент не обещает
   * человеку переключатель, которого в окне чата нет.
   */
  it('правило подбора модели снято: действий read/set_model_cascade и маршрута нет', async () => {
    for (const name of ['read_model_cascade', 'set_model_cascade']) {
      expect((await h.call(name, { project: projectDir })).outcome).toBe('unknown');
    }
    const route = await h.app.inject({
      method: 'GET',
      url: `/api/chat/cascade?path=${encodeURIComponent(projectDir)}`,
    });
    expect(route.statusCode).toBe(404);
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
});
