import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { registerChatRunRoutes } from '../routes/chat/run-routes.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Набор панели (В2) на проводке сборки: облачный Claude — без контура, без
 * локальной модели — получает флаг плагина по режиму со страницы. Юнит-тесты
 * `KitService` зеленеют и тогда, когда `runRoute` в `runtime.ts` набор не зовёт
 * или реестр теряет `route.kit`; здесь путь настоящий — маршрут отправки,
 * реестр прогонов, `runRoute` сборки, `KitService` на диске. Подменён только
 * процесс CLI (фабрика прогонов реестра): его опции и есть предмет.
 */

interface Started {
  args: string[];
  env: Record<string, string>;
}

describe('набор панели доезжает до прогона облачного Claude (runtime runRoute)', () => {
  let root: string;
  let project: string;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: Started[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-kit-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const ctx = {
      store: new AppStore(appData),
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
        started.push({ args: options.platformArgs ?? [], env: options.platformEnv ?? {} });
        onEvent({ kind: 'text', text: 'ок' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: `s-${started.length}` });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;

    app = Fastify();
    registerChatRunRoutes(app, ctx, runtime.chatRuns, runtime.chatSession);
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function send(chatId: string): Promise<Started | undefined> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt: 'скажи ок', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    for (let i = 0; i < 100 && runtime.chatRuns.isRunning(chatId); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
    return started.at(-1);
  }

  const kitDir = (mode: string) =>
    join(root, 'agentdeck', 'kit', 'effective', mode, 'agentdeck-kit');

  it('«глобальные» — ни флага плагина, ни варианта правил', async () => {
    runtime.kit.setMode('claude', 'global');
    const run = await send('глобальный');
    expect(run).toBeDefined();
    expect(run?.args).not.toContain('--plugin-dir');
    expect(run?.env.AGENTDECK_KIT_VARIANT).toBeUndefined();
  });

  it('«оба» — --plugin-dir собранного набора и стандартный вариант', async () => {
    runtime.kit.setMode('claude', 'hybrid');
    const run = await send('гибрид');
    expect(run?.args).toEqual(['--plugin-dir', kitDir('hybrid')]);
    expect(run?.env.AGENTDECK_KIT_VARIANT).toBe('standard');
  });

  it('«только наш» — плагин и снятый источник user; смена режима — со следующего сообщения', async () => {
    runtime.kit.setMode('claude', 'ours');
    expect((await send('наш'))?.args).toEqual([
      '--plugin-dir',
      kitDir('ours'),
      '--setting-sources',
      'project,local',
    ]);
    runtime.kit.setMode('claude', 'global');
    expect((await send('наш-2'))?.args).toEqual([]);
  });
});
