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
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../../domains/chat/run-options/run-options.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../../domains/chat/ChatHandoff/ChatHandoff.ts';
import {
  coreChatBookPath,
  createCoreChatBook,
} from '../../../domains/chat/core-run/core-chat-book.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { registerChatHandoffRoutes } from '../handoff-routes.ts';

/**
 * Чат при активном чужом CLI. `POST /api/chat/send` (телефон, API) и
 * продолжение в чистой сессии — ход чата через ядро. Раньше отправка брала команду
 * АКТИВНОГО провайдера и при активном Qwen запускала `qwen` с флагами Claude
 * (`--include-partial-messages --permission-prompt-tool …`); потом отказывала 409.
 * Теперь (W3-17a) ход уходит прогону ядра, а CLI — активный провайдер — выбирает
 * сам прогон (`core-run`, его тесты); сервер сам ни одного CLI не запускает.
 *
 * Доказательство — настоящий реестр прогонов и маршруты; в PATH лежат подставные
 * `claude` и `qwen`, которые записывают свои argv в файл: сервер сам не запускает
 * ни одного CLI. Ход Claude уходит в фабрику прогонов реестра — в сборке это
 * прогон ядра (`CoreChatRun`, этап 10, G14), здесь — записывающая подмена.
 * Модель, сеть и настоящие CLI не нужны, `~/.claude` и `~/.qwen` не трогаются.
 */

/** Прогон, который реестр получил от фабрики: что ушло в ядро, без процесса. */
class RecordingRun implements RunLike {
  private resolve?: () => void;
  private readonly seen: RunOptions[];
  constructor(seen: RunOptions[]) {
    this.seen = seen;
  }
  start(options: RunOptions): Promise<void> {
    this.seen.push(options);
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
  stop(): void {
    this.resolve?.();
  }
}

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

describe('чат при активном чужом CLI: ход через ядро, ни чужого бинаря с флагами Claude, ни отказа', () => {
  let root: string;
  let bin: string;
  let work: string;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let app: FastifyInstance;
  let savedPath: string | undefined;
  /** Ходы, отданные фабрике прогонов (в сборке — ядру). */
  let started: RunOptions[];

  beforeEach(async () => {
    started = [];
    root = mkdtempSync(join(tmpdir(), 'cc-foreign-send-'));
    bin = join(root, 'bin');
    work = join(root, 'work');
    for (const dir of [bin, work, join(root, 'agentdeck')]) mkdirSync(dir, { recursive: true });
    fakeClis(bin, ['claude', 'qwen']);
    savedPath = process.env[pathKey()];
    process.env[pathKey()] = `${bin}${delimiter}${savedPath ?? ''}`;

    store = new AppStore(join(root, 'agentdeck'));
    // Фабрика прогонов — граница с ядром: записывает, что ей отдали.
    registry = new ChatRunRegistry(() => new RecordingRun(started));
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
      // Каталог по вендорам: у Anthropic свежий Sonnet, у прочих пусто — по нему видно, по чьему
      // каталогу сервер разворачивает алиас модели.
      models: {
        current: (vendors: string[]) => ({
          models: vendors.includes('anthropic')
            ? [
                {
                  id: 'claude-sonnet-5-5',
                  name: 'Claude Sonnet 5.5',
                  family: 'claude-sonnet',
                  vendor: 'anthropic',
                  releaseDate: '2026-10-01',
                },
              ]
            : [],
        }),
      },
    } as unknown as ServerContext;
    app = Fastify();
    const session = new ChatSession(registry);
    registerChatRunRoutes(app, ctx, registry, session);
    registerChatHandoffRoutes(app, ctx, { runs: registry, chains: new HandoffChains(), session });
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

  // W3-17a: один чат — ход идёт активным провайдером через ядро (CLI выбирает прогон ядра по
  // настройке), а не отказ «только Claude»; сам сервер ни qwen, ни claude не запускает.
  it('Qwen активен — ход уходит в прогон ядра, отказа 409 нет, сервер сам CLI не запускает', async () => {
    store.updateSettings({ provider: 'qwen' });

    let status = 0;
    void send().then((reply) => (status = reply.statusCode));
    await until(() => started.length > 0);
    // Дать ошибочному запуску время дойти до файла: без исправления он туда пишет.
    await until(() => calls(bin).length > 0, 500);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ prompt: 'привет', cwd: work });
    expect(status).not.toBe(409);
    expect(calls(bin)).toEqual([]);
  });

  it('Qwen активен — флаг очереди (queueIfBusy) тоже ведёт ход в прогон ядра', async () => {
    store.updateSettings({ provider: 'qwen' });
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'phone-chat', prompt: 'в очередь', projectPath: work, queueIfBusy: true },
    });
    await until(() => started.length > 0);
    expect(started[0]).toMatchObject({ prompt: 'в очередь' });
  });

  // Разговор не-Claude CLI транскрипта Claude не пишет: продолжение узнаётся по книге чата ядра.
  it('разговор, известный только книге чата ядра, продолжается; незнакомый — 404 session_unknown', async () => {
    store.updateSettings({ provider: 'qwen' });
    createCoreChatBook(coreChatBookPath(join(root, 'agentdeck'))).set('qwen-conv-1', {
      taskId: 't',
      stepId: 's',
      cli: 'qwen',
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'c2', sessionId: 'nobody-knows', prompt: 'эй', projectPath: work },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'session_unknown' });

    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: 'c1', sessionId: 'qwen-conv-1', prompt: 'дальше', projectPath: work },
    });
    await until(() => started.length > 0);
    expect(started[0]).toMatchObject({ prompt: 'дальше', sessionId: 'qwen-conv-1', cwd: work });
  });

  // Ревью W3-17a (M-F3): разговор Claude при активном Qwen идёт Claude (книга), и алиас «Sonnet»
  // разворачивается по каталогу Claude — по каталогу Qwen он оставался голым алиасом.
  it('разговор Claude при активном Qwen: алиас модели разворачивается по каталогу Claude', async () => {
    store.updateSettings({ provider: 'qwen' });
    const book = createCoreChatBook(coreChatBookPath(join(root, 'agentdeck')));
    book.set('claude-conv-1', { taskId: 't', stepId: 's', cli: 'claude' });
    void app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: 'c1',
        sessionId: 'claude-conv-1',
        prompt: 'дальше',
        projectPath: work,
        model: 'sonnet',
      },
    });
    await until(() => started.length > 0);
    expect(started[0]).toMatchObject({ sessionId: 'claude-conv-1', model: 'claude-sonnet-5-5' });
  });

  // Старая ссылка `/core/chat?id=<задача>` (W3-17a): веб спрашивает, какой разговор ведёт задача.
  it('GET /api/chat/core-task/:taskId — разговор задачи по книге чата; незнакомая задача — null', async () => {
    createCoreChatBook(coreChatBookPath(join(root, 'agentdeck'))).set('qwen-conv-9', {
      taskId: 'task-9',
      stepId: 's',
      cli: 'qwen',
    });
    const known = await app.inject({ method: 'GET', url: '/api/chat/core-task/task-9' });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ chatId: 'qwen-conv-9' });
    const unknown = await app.inject({ method: 'GET', url: '/api/chat/core-task/task-0' });
    expect(unknown.json()).toEqual({ chatId: null });
  });

  // Шапка чата берёт каталог моделей CLI разговора (W3-17a), а не активного провайдера.
  it('GET /api/chat/core-cli/:chatId — CLI разговора по книге; запись без CLI и незнакомый — claude', async () => {
    const book = createCoreChatBook(coreChatBookPath(join(root, 'agentdeck')));
    book.set('codex-conv-7', { taskId: 'task-7', stepId: 's', cli: 'codex' });
    // Задача кончилась — книга помнит CLI и после `forget`.
    book.forget('codex-conv-7');
    const known = await app.inject({ method: 'GET', url: '/api/chat/core-cli/codex-conv-7' });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ cli: 'codex' });
    const unknown = await app.inject({ method: 'GET', url: '/api/chat/core-cli/old-claude-conv' });
    expect(unknown.json()).toEqual({ cli: 'claude' });
    const bad = await app.inject({ method: 'GET', url: '/api/chat/core-cli/..%2Fx' });
    expect(bad.json()).toEqual({ cli: 'claude' });
  });

  it('Claude активен — ход уходит в прогон ядра, сервер сам CLI не запускает', async () => {
    // Ответ отправки ждёт конца хода — ход здесь не кончается, смотрим на старт.
    void send();
    await until(() => started.length > 0);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ prompt: 'привет', cwd: work });
    expect(calls(bin)).toEqual([]);
  });

  // Этап 11, волна 3: продолжение к чужому CLI садится как у Claude — прогоном реестра под ключом
  // `new-…` (CLI берёт прогон ядра), а не задачей ядра мимо реестра без id разговора.
  it('продолжение в чистой сессии при Qwen — прогон реестра под ключом вкладки, инициатива текстом после задания, сервер сам ничего не запускает', async () => {
    store.updateSettings({ provider: 'qwen' });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: {
        projectPath: work,
        chatId: 'sess-1',
        proposal: { done: 'этап закрыт', next: 'дальше', checkpoint: '.agent/PROGRESS.md' },
      },
    });
    await until(() => started.length > 0);

    expect(reply.statusCode).toBe(200);
    const body = reply.json<{ chatId: string; started: boolean }>();
    expect(body.started).toBe(true);
    expect(registry.isRunning(body.chatId)).toBe(true);
    // Ход чужого CLI ведёт ядро: ни qwen, ни claude сервер не спавнит.
    expect(calls(bin)).toEqual([]);
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(work);
    const prompt = started[0]?.prompt ?? '';
    expect(prompt).toContain('.agent/PROGRESS.md');
    // Системной дописки чужому CLI прогон ядра не передаёт: инициатива — в тексте, после задания.
    expect(started[0]?.appendSystemPrompt).toBeUndefined();
    expect(prompt.indexOf('This run was started from the AgentDeck panel')).toBeGreaterThan(
      prompt.indexOf('.agent/PROGRESS.md'),
    );
  });

  it('продолжение в чистой сессии при Claude — ход в прогон ядра с точкой возврата, без своего CLI', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: {
        projectPath: work,
        chatId: 'sess-1',
        proposal: { done: 'этап закрыт', next: 'дальше', checkpoint: '.agent/PROGRESS.md' },
      },
    });
    await until(() => started.length > 0);

    expect(reply.statusCode).toBe(200);
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(work);
    expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
    expect(calls(bin)).toEqual([]);
  });
});
