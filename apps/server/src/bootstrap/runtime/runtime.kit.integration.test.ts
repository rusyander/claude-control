import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { registerChatRunRoutes } from '../../routes/chat/run-routes/run-routes.ts';
import {
  LOCAL_CONSUMERS,
  LOCAL_PLATFORM_ID,
  LOCAL_PLATFORM_TOKEN,
  localPlatformSettings,
} from '../../domains/local-models/connect.ts';
import { writePlatform, writeToken } from '../../domains/platform/store/store.ts';
import { platformSchema } from '../../providers/settings-validation/settings-validation.ts';
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
  let store: AppStore;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-kit-')));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    project = join(root, 'project');
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

  it('контур локальной модели — локальный вариант правил и вызовы инструментов по одному', async () => {
    // Контур заведён так же, как его заводит «Скачать и подключить» (`connect.ts`):
    // та же форма настроек через схему, ключ-заглушка, активен; шлюз — живой.
    const appData = join(root, 'agentdeck');
    const settings = platformSchema.parse(
      localPlatformSettings({
        baseUrl: 'http://127.0.0.1:11435',
        model: 'qwen3-coder:30b',
        title: 'Локальная модель',
        consumers: LOCAL_CONSUMERS,
      }),
    );
    writePlatform(store, settings);
    writeToken(appData, LOCAL_PLATFORM_ID, LOCAL_PLATFORM_TOKEN);
    store.updateSettings({ activePlatformId: LOCAL_PLATFORM_ID });
    await runtime.platformGateway.start({ store, appDataDir: appData, port: 0 });
    try {
      runtime.kit.setMode('claude', 'hybrid');
      const run = await send('локальный');
      expect(run?.args).toContain('--plugin-dir');
      expect(run?.env.ANTHROPIC_BASE_URL).toContain(`/${LOCAL_PLATFORM_ID}/`);
      expect(run?.env.AGENTDECK_KIT_VARIANT).toBe('local');
      expect(run?.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).toBe('1');
    } finally {
      await runtime.platformGateway.stop();
    }
  });
});
