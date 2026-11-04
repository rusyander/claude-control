import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { getProvider, listProviders } from '../../providers/registry.ts';
import { createChat } from '../../domains/provider-chat/store/store.ts';
import { sandboxPaths } from '../../domains/sandbox/SandboxConfig.ts';
import { registerPluginRoutes } from '../plugin-routes/plugin-routes.ts';
import { registerSandboxRoutes } from '../sandbox-routes/sandbox-routes.ts';
import {
  FAKE_TURN,
  fakeCorePort,
  type FakeCorePort,
} from '../../domains/project-tests/agent/__fixtures__/fake-core-port.ts';
import { registerProviderChatRoutes } from '../provider-chat-routes/provider-chat-routes.ts';

/**
 * Разделы, которые работают только у части CLI, отказывают ДО запуска процесса.
 *
 * Раньше `/api/plugins*` запускали АКТИВНЫЙ CLI с аргументами плагинов Claude
 * (`kimi plugin list --json`) и читали каталог плагинов Claude, песочница
 * поднимала настоящий `claude` при любом активном CLI, а чат Cursor заводил
 * разговор, который потом падал невнятным «нет ни ключа, ни CLI».
 *
 * Свидетельство — журнал фальшивых CLI первыми в PATH: каждый пишет свой argv.
 * Отказ без единой строки в журнале — это решение маршрута, а не «CLI не найден»:
 * у Claude тот же журнал получает запуск (контроль, что подмена вообще видна).
 */

interface Call {
  cli: string;
  argv: string[];
}

const IS_WIN = process.platform === 'win32';

/** Фальшивые CLI под настоящими именами: строка журнала на запуск и пустой ответ. */
function fakeClis(bin: string, names: string[]): () => Call[] {
  mkdirSync(bin, { recursive: true });
  const journal = join(bin, 'calls.jsonl');
  for (const name of names) {
    const script = join(bin, `${name}.mjs`);
    writeFileSync(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ cli: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + '\\n');`,
        "process.stdout.write('[]');",
      ].join('\n'),
      'utf8',
    );
    if (IS_WIN) {
      writeFileSync(
        join(bin, `${name}.cmd`),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o755,
      });
    }
  }
  return () =>
    existsSync(journal)
      ? readFileSync(journal, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : [];
}

const FOREIGN = listProviders().filter((provider) => provider.id !== 'claude');

describe('provider-guard: отказ до запуска CLI', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance | undefined;
  let calls: () => Call[];
  let core: FakeCorePort | undefined;
  const sandboxId = `qa-guard-${process.pid}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-provider-guard-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    // Дом процесса — временный: корень песочниц (`~/.agentdeck/sandboxes`) и всё,
    // что читается от дома, уходит туда, а не в настоящий профиль.
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('USERPROFILE', join(root, 'home'));
    const bin = join(root, 'bin');
    calls = fakeClis(bin, ['claude', 'kimi', 'cursor-agent', 'gemini']);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const boot = async (provider: string): Promise<ServerContext> => {
    const store = new AppStore(appData);
    if (provider !== 'claude') store.updateSettings({ provider });
    const ctx = {
      location: { paths: { root, appData } },
      store,
      models: { current: () => ({ models: [] }) },
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    app = Fastify();
    registerPluginRoutes(app, ctx);
    // Разговор песочницы — задача ядра: порт ядра подставной, настоящее ядро машины тест не трогает.
    core = fakeCorePort({ turn: FAKE_TURN });
    registerSandboxRoutes(app, ctx, { corePort: () => core!.port });
    registerProviderChatRoutes(app, ctx);
    await app.ready();
    return ctx;
  };

  const inject = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app!.inject({ method, url, ...(payload ? { payload } : {}) });

  describe('плагины Claude (`/api/plugins*`)', () => {
    const ROUTES: [method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object][] = [
      ['GET', '/api/plugins'],
      ['GET', '/api/plugins/available'],
      ['POST', '/api/plugins/install', { id: 'demo@market' }],
      ['POST', '/api/plugins/demo@market/uninstall'],
      ['POST', '/api/plugins/demo@market/enabled', { isEnabled: true }],
      ['POST', '/api/plugins/demo@market/update'],
      ['POST', '/api/plugins/marketplaces', { source: 'owner/repo' }],
      ['DELETE', '/api/plugins/marketplaces/market'],
    ];

    it.each(ROUTES)('Kimi Code: %s %s — 409 и ни одного запуска CLI', async (method, url, body) => {
      await boot('kimi');
      const answer = await inject(method, url, body);

      expect(answer.statusCode).toBe(409);
      expect(answer.json()).toMatchObject({
        messageCode: 'plugins-provider-unsupported',
        params: { provider: getProvider('kimi').name },
      });
      expect(calls()).toEqual([]);
    });

    it.each(FOREIGN.map((provider) => provider.id))(
      '%s: GET /api/plugins — отказ (у чужого CLI свой раздел плагинов или его нет)',
      async (id) => {
        await boot(id);
        const answer = await inject('GET', '/api/plugins');

        expect(answer.statusCode).toBe(409);
        expect(calls()).toEqual([]);
      },
    );

    it('Claude: GET /api/plugins доходит до claude — подмена CLI видна журналу', async () => {
      await boot('claude');
      const answer = await inject('GET', '/api/plugins');

      expect(answer.statusCode).toBe(200);
      expect(calls().map((call) => call.cli)).toContain('claude');
      expect(
        calls()
          .find((call) => call.cli === 'claude')
          ?.argv.slice(0, 2),
      ).toEqual(['plugin', 'list']);
    });

    it('скаффолдер CLI не запускает и остаётся доступен при любом CLI', async () => {
      await boot('kimi');
      const answer = await inject('POST', '/api/plugins/scaffold', {});

      expect(answer.statusCode).toBe(400);
      expect(answer.json()).toMatchObject({ messageCode: 'plugin-dir-or-name-unspecified' });
    });
  });

  describe('песочница (`/api/sandbox/*`)', () => {
    const ROUTES: [method: 'POST', url: string, payload: object][] = [
      ['POST', '/api/sandbox/create', { id: sandboxId }],
      ['POST', '/api/sandbox/run', { id: sandboxId, prompt: 'проверь правило' }],
      ['POST', '/api/sandbox/probe-hook', { id: sandboxId, scriptName: 'guard.mjs' }],
      ['POST', '/api/sandbox/mcp-tools', { mcpId: 'demo' }],
      ['POST', '/api/sandbox/mcp-call', { mcpId: 'demo', tool: 'echo' }],
    ];

    it.each(ROUTES)(
      'Kimi Code: %s %s — 409, песочница не собрана, CLI не запущен',
      async (method, url, body) => {
        await boot('kimi');
        const answer = await inject(method, url, body);

        expect(answer.statusCode).toBe(409);
        expect(answer.json()).toMatchObject({
          messageCode: 'sandbox-provider-unsupported',
          params: { provider: getProvider('kimi').name },
        });
        expect(calls()).toEqual([]);
        expect(existsSync(sandboxPaths(sandboxId).root)).toBe(false);
      },
    );

    it.each(FOREIGN.map((provider) => provider.id))(
      '%s: прогон песочницы — отказ без запуска claude',
      async (id) => {
        await boot(id);
        const answer = await inject('POST', '/api/sandbox/run', {
          id: sandboxId,
          prompt: 'вопрос',
        });

        expect(answer.statusCode).toBe(409);
        expect(calls()).toEqual([]);
      },
    );

    it('образцы событий и уборка песочницы доступны при любом CLI', async () => {
      await boot('kimi');

      expect((await inject('GET', '/api/sandbox/fixtures')).statusCode).toBe(200);
      expect((await inject('DELETE', `/api/sandbox/${sandboxId}`)).statusCode).toBe(200);
    });

    it('Claude: страж раздел пропускает, прогон песочницы — задача ядра, панель claude сама не запускает', async () => {
      await boot('claude');
      // Состав уже собран: проверяется запуск, а не сборка.
      mkdirSync(sandboxPaths(sandboxId).configDir, { recursive: true });
      mkdirSync(sandboxPaths(sandboxId).workDir, { recursive: true });
      const answer = await inject('POST', '/api/sandbox/run', { id: sandboxId, prompt: 'вопрос' });

      expect(answer.statusCode).toBe(200);
      expect(answer.body).toContain('"kind":"done"');
      expect(core!.calls[0]).toMatchObject({ kind: 'set-cli', fields: { adapter: 'claude' } });
      expect(calls()).toEqual([]);
    });
  });

  describe('чат чужого CLI (`/api/provider-chat/*`)', () => {
    // Ход чужого CLI идёт чатом ядра: прежние маршруты прогона отказывают по имени при любом CLI,
    // и ни один процесс CLI панель не запускает.
    it.each(['cursor', 'gemini'])(
      '%s: заведение, отправка, очередь и перезапуск — 410 provider-chat-core без прогона',
      async (id) => {
        await boot(id);
        const chat = createChat(appData, id, { workdir: root });
        expect(chat).toBeDefined();
        const base = `/api/provider-chat/chats/${chat!.id}`;
        const answers = [
          await inject('POST', '/api/provider-chat/chats', {}),
          await inject('POST', `${base}/send`, { text: 'привет' }),
          await inject('POST', `${base}/send`, { text: 'ещё', queueIfBusy: true }),
          await inject('POST', `${base}/restart`),
          await inject('POST', `${base}/queue/q1/send`),
        ];
        for (const answer of answers) {
          expect(answer.statusCode).toBe(410);
          expect(answer.json()).toMatchObject({ messageCode: 'provider-chat-core' });
        }
        expect(calls()).toEqual([]);
      },
    );
  });
});
