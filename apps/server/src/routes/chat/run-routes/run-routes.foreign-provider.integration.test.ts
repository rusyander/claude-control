import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { ChatRunRegistry } from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { ProviderChatService } from '../../../domains/provider-chat/provider-chat.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { registerChatHandoffRoutes } from '../handoff-routes.ts';

/**
 * Чат Claude при активном чужом CLI. `POST /api/chat/send` (телефон, API) и
 * продолжение в чистой сессии собирают аргументы `ChatRunner` — флаги Claude.
 * Раньше отправка брала команду АКТИВНОГО провайдера и при активном Qwen
 * запускала `qwen` с `--include-partial-messages --permission-prompt-tool …`.
 *
 * Доказательство — настоящий реестр прогонов и настоящий `spawn`: в PATH лежат
 * подставные `claude` и `qwen`, которые записывают свои argv в файл. Модель,
 * сеть и настоящие CLI не нужны, `~/.claude` и `~/.qwen` не трогаются.
 */

/** Флаг, который ставит только `ChatRunner` (Claude), — ни один адаптер чужого CLI его не шлёт. */
const CLAUDE_MARKER = '--include-partial-messages';

interface Call {
  name: string;
  argv: string[];
}

function pathKey(): string {
  return Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** Подставные CLI: `<name>` (sh) и `<name>.cmd` (Windows) зовут один дампер argv. */
function fakeClis(bin: string, names: string[]): void {
  writeFileSync(
    join(bin, 'dump.cjs'),
    [
      "const { appendFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const [name, ...argv] = process.argv.slice(2);',
      "appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ name, argv }) + '\\n');",
    ].join('\n'),
  );
  for (const name of names) {
    writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0dump.cjs" ${name} %*\r\n`);
    const sh = join(bin, name);
    writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/dump.cjs" ${name} "$@"\n`);
    chmodSync(sh, 0o755);
  }
}

function calls(bin: string): Call[] {
  const file = join(bin, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe('чат Claude при активном чужом CLI: ни чужого бинаря с флагами Claude, ни тихого Claude', () => {
  let root: string;
  let bin: string;
  let work: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let app: FastifyInstance;
  let savedPath: string | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-foreign-send-'));
    bin = join(root, 'bin');
    work = join(root, 'work');
    for (const dir of [bin, work, join(root, 'agentdeck')]) mkdirSync(dir, { recursive: true });
    fakeClis(bin, ['claude', 'qwen']);
    savedPath = process.env[pathKey()];
    process.env[pathKey()] = `${bin}${delimiter}${savedPath ?? ''}`;

    store = new AppStore(join(root, 'agentdeck'));
    // Настоящая фабрика прогонов — та, что зовёт `spawn`.
    registry = new ChatRunRegistry();
    const ctx = {
      store,
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
      backupDir: join(root, 'agentdeck', 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    const session = new ChatSession(registry);
    registerChatRunRoutes(app, ctx, registry, session);
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session,
    });
    await app.ready();
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    if (savedPath === undefined) delete process.env[pathKey()];
    else process.env[pathKey()] = savedPath;
    // Windows держит каталог, пока не вышла оболочка подставного CLI (рабочая
    // папка процесса внутри `root`): ждём её, а не падаем на EPERM.
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  });

  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'phone-chat', prompt: 'привет', projectPath: work },
    });

  it('Qwen активен — отправка отказывает кодом, ни qwen, ни claude не запускаются', async () => {
    store.updateSettings({ provider: 'qwen' });

    const reply = await send();
    // Дать ошибочному запуску время дойти до файла: без исправления он туда пишет.
    await until(() => calls(bin).length > 0, 1500);

    expect(calls(bin)).toEqual([]);
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({
      code: 'provider_not_claude',
      provider: 'qwen',
      messageCode: 'chat-send-foreign-provider',
      params: { provider: expect.any(String) },
    });
  });

  it('Qwen активен — флаг очереди (queueIfBusy) отказ не обходит', async () => {
    store.updateSettings({ provider: 'qwen' });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'phone-chat', prompt: 'в очередь', projectPath: work, queueIfBusy: true },
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({ messageCode: 'chat-send-foreign-provider' });
  });

  it('Claude активен — тот же стенд видит запуск: claude с флагами Claude', async () => {
    void send();
    await until(() => calls(bin).length > 0);

    const seen = calls(bin);
    expect(seen.map((call) => call.name)).toEqual(['claude']);
    expect(seen[0]?.argv).toContain(CLAUDE_MARKER);
  });

  it('продолжение в чистой сессии при Qwen — путём Qwen, без флагов Claude', async () => {
    store.updateSettings({ provider: 'qwen' });
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: {
        projectPath: work,
        chatId: 'sess-1',
        proposal: { done: 'этап закрыт', next: 'дальше', checkpoint: '.agent/PROGRESS.md' },
      },
    });
    await until(() => calls(bin).length > 0);

    const seen = calls(bin);
    expect(seen.map((call) => call.name)).toEqual(['qwen']);
    expect(seen[0]?.argv).not.toContain(CLAUDE_MARKER);
  });

  it('продолжение в чистой сессии при Claude — claude с флагами Claude', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: {
        projectPath: work,
        chatId: 'sess-1',
        proposal: { done: 'этап закрыт', next: 'дальше', checkpoint: '.agent/PROGRESS.md' },
      },
    });
    await until(() => calls(bin).length > 0);

    const seen = calls(bin);
    expect(seen.map((call) => call.name)).toEqual(['claude']);
    expect(seen[0]?.argv).toContain(CLAUDE_MARKER);
  });
});
