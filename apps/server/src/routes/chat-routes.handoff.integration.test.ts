import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG } from '@claude-control/contracts/chat-handoff';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { createHandoffPlanner, registerChatHandoffRoutes } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';

/**
 * Продолжение работы в чистой сессии: маршруты и планировщик вместе.
 *
 * Проверяется склейка «маршрут → домен → реестр прогонов» и то, ради чего
 * планировщик вообще живёт на сервере: завершившийся прогон сам заводит
 * следующий разговор — и отказывается это делать, когда файл-опора не обновлён.
 */

const PROPOSAL = {
  done: 'этап закрыт',
  next: 'дальше — документация',
  checkpoint: '.agent/PROGRESS.md',
};

function block(json: unknown): string {
  return ['```' + HANDOFF_BLOCK_LANG, JSON.stringify(json), '```'].join('\n');
}

describe('маршруты продолжения в чистой сессии', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let started: { chatId: string; prompt: string; cwd: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-handoff-'));
    project = mkdtempSync(join(tmpdir(), 'cc-handoff-proj-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          prompt: options.prompt,
          cwd: options.cwd,
        });
      },
      stop: () => undefined,
    }));

    store = new AppStore(join(root, 'claude-control'));
    const ctx = {
      location: {
        paths: {
          root,
          appData: join(root, 'claude-control'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(root, 'claude-control', 'backups'),
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;

    app = Fastify();
    registerChatHandoffRoutes(app, ctx, {
      runs: registry,
      chains: new HandoffChains(),
      providerChats: new ProviderChatService(),
      session: new ChatSession(registry),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('набор проекта включается и для продолжения', async () => {
    // Продолжение стартует агента само, минуя отправку из поля ввода: без
    // включения набора «чистая сессия» получала бы окружение без правил и
    // скиллов проекта, хотя каталог тот же самый.
    store.saveGroup({
      id: 'набор',
      name: 'Набор проекта',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [],
      env: {},
      isEnabled: false,
      order: 0,
      projectPaths: [project],
    });

    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-1', proposal: PROPOSAL },
    });

    expect(store.getGroups()[0]?.isEnabled).toBe(true);
  });

  it('заводит продолжение в том же каталоге и запускает прогон', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, chatId: 'sess-1', proposal: PROPOSAL },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ path: project, started: true, chainDepth: 1 });
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(project);
    // Задание новой сессии обязано назвать файл-опору: контекста у неё нет.
    expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
  });

  it('«только завести чат» отдаёт задание, не запуская прогон', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, proposal: PROPOSAL, startRun: false },
    });

    expect(response.json()).toMatchObject({ started: false });
    expect(response.json().prompt).toContain(PROPOSAL.next);
    expect(started).toHaveLength(0);
  });

  it('неразобранное предложение отклоняется, а не заводит пустой чат', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: project, proposal: { done: 'только это' } },
    });

    expect(response.statusCode).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('без каталога проекта продолжать негде', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/handoff',
      payload: { projectPath: join(project, 'нет-такого'), proposal: PROPOSAL },
    });

    expect(response.statusCode).toBe(400);
  });

  it('тумблер автомата ставится по одному написанию ключа, читается по другому', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/chat/handoff/auto',
      payload: { chatId: 'new-1', sessionId: 'sess-1', enabled: true },
    });

    const state = await app.inject({ method: 'GET', url: '/api/chat/handoff/state?chatId=sess-1' });
    expect(state.json()).toMatchObject({ auto: true, depth: 0 });
  });

  it('просьба по кнопке описывает и уборку, и формат блока', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/handoff/request' });
    const { prompt } = response.json();
    expect(prompt).toContain(HANDOFF_BLOCK_LANG);
    expect(prompt).toContain('ARCHIVE.md');
  });
});

describe('планировщик продолжения', () => {
  /** Прогон-заглушка: печатает заданный текст и завершается. */
  function fakeRun(text: string): RunLike {
    return {
      start: async (_options, onEvent) => {
        onEvent({ kind: 'text', text });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' });
      },
      stop: () => undefined,
    };
  }

  function build(text: string, mtime: number | undefined, contextLimit = 0) {
    const chains = new HandoffChains();
    const registry = new ChatRunRegistry(() => fakeRun(text));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains,
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        contextLimit: () => contextLimit,
        stat: () => mtime,
      }),
    );
    return { chains, registry };
  }

  /** Прогон, который перед завершением сообщает размер окна. */
  function fakeRunWithContext(text: string, context: number): RunLike {
    return {
      start: async (_options, onEvent) => {
        onEvent({ kind: 'text', text });
        onEvent({
          kind: 'usage',
          input: 10,
          output: 5,
          cacheRead: context - 10,
          cacheCreation: 0,
        });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' });
      },
      stop: () => undefined,
    };
  }

  function buildWithContext(context: number, mtime: number | undefined, limit: number) {
    const chains = new HandoffChains();
    const registry = new ChatRunRegistry(() => fakeRunWithContext('Работаю дальше.', context));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains,
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        contextLimit: () => limit,
        stat: () => mtime,
      }),
    );
    return { chains, registry };
  }

  /** Ленты одного прогона: какие события продолжения увидела вкладка. */
  function watch(registry: ChatRunRegistry, chatId: string) {
    const seen: { reason?: string; contextTokens?: number }[] = [];
    registry.attach(chatId, 0, {
      send: ({ event }) => {
        if (event.kind === 'handoff') {
          seen.push({
            ...(event.reason ? { reason: event.reason } : {}),
            ...(event.contextTokens ? { contextTokens: event.contextTokens } : {}),
          });
        }
      },
      close: () => undefined,
    });
    return seen;
  }

  it('после успешного прогона со свежим чекпойнтом заводит новую сессию сам', async () => {
    const { chains, registry } = build(`Готово.\n\n${block(PROPOSAL)}`, Date.now() + 10_000);
    chains.setAuto(['чат-1'], true);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    await new Promise((done) => setTimeout(done, 20));

    // Новый разговор виден реестру: это и есть продолжение цепочки.
    const active = registry.active().map((run) => run.chatId);
    expect(active.some((id) => id.startsWith('new-'))).toBe(true);
  });

  it('несвежий файл-опора: продолжения нет, причина уходит в ленту', async () => {
    const { chains, registry } = build(`Готово.\n\n${block(PROPOSAL)}`, 1);
    chains.setAuto(['чат-1'], true);

    const seen: string[] = [];
    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    registry.attach('чат-1', 0, {
      send: ({ event }) => {
        if (event.kind === 'handoff') seen.push(event.reason ?? 'ok');
      },
      close: () => undefined,
    });
    await new Promise((done) => setTimeout(done, 20));

    expect(registry.active().every((run) => !run.chatId.startsWith('new-'))).toBe(true);
    expect(seen).toContain('checkpoint_stale');
  });

  it('без включённого тумблера панель молчит и ничего не заводит', async () => {
    const { registry } = build(`Готово.\n\n${block(PROPOSAL)}`, Date.now() + 10_000);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    await new Promise((done) => setTimeout(done, 20));

    expect(registry.active().every((run) => !run.chatId.startsWith('new-'))).toBe(true);
  });

  it('окно переросло порог без блока в ответе: предложение с размером окна', async () => {
    const { registry } = buildWithContext(250_000, Date.now() + 10_000, 200_000);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    const seen = watch(registry, 'чат-1');
    await new Promise((done) => setTimeout(done, 20));

    expect(seen).toEqual([{ reason: 'context_high', contextTokens: 250_000 }]);
    // Сама панель ничего не завела: тумблер выключен, решает человек.
    expect(registry.active().every((run) => !run.chatId.startsWith('new-'))).toBe(true);
  });

  it('с включённым автоматом порог продолжает работу сам', async () => {
    const { chains, registry } = buildWithContext(250_000, Date.now() + 10_000, 200_000);
    chains.setAuto(['чат-1'], true);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    await new Promise((done) => setTimeout(done, 20));

    expect(registry.active().some((run) => run.chatId.startsWith('new-'))).toBe(true);
  });

  it('несвежий чекпойнт при пороге: причина названа, разговор не стёрт', async () => {
    const { chains, registry } = buildWithContext(250_000, 1, 200_000);
    chains.setAuto(['чат-1'], true);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    const seen = watch(registry, 'чат-1');
    await new Promise((done) => setTimeout(done, 20));

    expect(seen[0]?.reason).toBe('checkpoint_stale');
    expect(registry.active().every((run) => !run.chatId.startsWith('new-'))).toBe(true);
  });

  it('порог ниже окна не трогает разговор, пока слежение выключено нулём', async () => {
    const { registry } = buildWithContext(250_000, Date.now() + 10_000, 0);

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    const seen = watch(registry, 'чат-1');
    await new Promise((done) => setTimeout(done, 20));

    expect(seen).toEqual([]);
  });

  it('о том же окне не напоминает дважды', () => {
    const chains = new HandoffChains();
    expect(chains.shouldNoticeContext(['чат-1'], 210_000)).toBe(true);
    expect(chains.shouldNoticeContext(['чат-1'], 215_000)).toBe(false);
    // Выросло ещё на шаг — повод сказать снова.
    expect(chains.shouldNoticeContext(['чат-1'], 240_000)).toBe(true);
  });
});
