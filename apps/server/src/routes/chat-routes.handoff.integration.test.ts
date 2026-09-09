import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOFF_BLOCK_LANG, HANDOFF_MAX_CHAIN } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { createHandoffPlanner, registerChatHandoffRoutes } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

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

/** Контекст сервера на временном каталоге — тот же, что собирает beforeEach. */
function ctxOf(root: string, store: AppStore): ServerContext {
  return {
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
}

describe('маршруты продолжения в чистой сессии', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let started: { chatId: string; prompt: string; cwd: string; model?: string; effort?: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-handoff-'));
    project = mkdtempSync(join(tmpdir(), 'cc-handoff-proj-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });

    started = [];
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          prompt: options.prompt,
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        });
      },
      stop: () => undefined,
    }));

    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
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

  describe('перезапуск сессии по кнопке', () => {
    it('во время прогона — 409, ничего не заведено', async () => {
      // Прогон, который не завершается сам: реестр считает его идущим.
      const registry = new ChatRunRegistry((): RunLike => ({
        start: () => new Promise(() => undefined),
        stop: () => undefined,
      }));
      const busy = Fastify();
      registerChatHandoffRoutes(busy, ctxOf(root, store), {
        runs: registry,
        chains: new HandoffChains(),
        providerChats: new ProviderChatService(),
        session: new ChatSession(registry),
      });
      await busy.ready();
      registry.start('sess-busy', { prompt: 'работай', cwd: project }, { projectPath: project });

      const response = await busy.inject({
        method: 'POST',
        url: '/api/chat/sess-busy/restart',
        payload: { projectPath: project },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('идёт');
      await busy.close();
    });

    it('без транскрипта файл-опора считается несвежей: просьба обновить + автомат включён', async () => {
      const chains = new HandoffChains();
      const quiet = Fastify();
      const registry = new ChatRunRegistry((): RunLike => ({
        start: async () => undefined,
        stop: () => undefined,
      }));
      registerChatHandoffRoutes(quiet, ctxOf(root, store), {
        runs: registry,
        chains,
        providerChats: new ProviderChatService(),
        session: new ChatSession(registry),
      });
      await quiet.ready();

      const response = await quiet.inject({
        method: 'POST',
        url: '/api/chat/new-7/restart',
        payload: { projectPath: project },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.mode).toBe('requested');
      expect(body.prompt).toContain('Обнови .agent/PROGRESS.md');
      expect(body.prompt).toContain(HANDOFF_BLOCK_LANG);
      expect(chains.isAuto(['new-7'])).toBe(true);
      expect(registry.active()).toHaveLength(0);
      await quiet.close();
    });

    it('свежий файл-опора: продолжение заводится сразу с последней репликой человека как заданием', async () => {
      // Транскрипт разговора — под каталогом проектов панели, как его пишет CLI.
      const projectsRoot = join(root, 'projects', 'proj');
      mkdirSync(projectsRoot, { recursive: true });
      const turnAt = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(
        join(projectsRoot, 'sess-fresh.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            sessionId: 'sess-fresh',
            timestamp: turnAt,
            cwd: project,
            message: { role: 'user', content: 'Сделай экспорт отчётов' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            sessionId: 'sess-fresh',
            timestamp: new Date().toISOString(),
            cwd: project,
            message: { role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] },
          }),
        ].join('\n') + '\n',
      );
      mkdirSync(join(project, '.agent'), { recursive: true });
      writeFileSync(join(project, '.agent', 'PROGRESS.md'), 'next: документация\n');

      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/sess-fresh/restart',
        payload: { projectPath: project, sessionId: 'sess-fresh', allowEdits: true },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ mode: 'started', started: true, path: project, chainDepth: 1 });
      expect(started).toHaveLength(1);
      expect(started[0]?.prompt).toContain('.agent/PROGRESS.md');
      expect(started[0]?.prompt).toContain('Исходное задание');
      expect(started[0]?.prompt).toContain('Сделай экспорт отчётов');
    });
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

  /**
   * Продолжение — тот же разговор по смыслу, и модель у него та же. Чат,
   * заведённый разделением, ведётся подобранной под его задачу моделью, и
   * «чистая сессия» не повод вернуть его на дефолт из настроек: телефон и
   * API-клиенты модель не шлют вовсе.
   */
  describe('наследование модели', () => {
    beforeEach(() => {
      store.updateSettings({ chatModel: 'claude-opus-5', chatEffort: 'high' });
      store.setChatLink('sess-1', {
        parentChatId: 'parent-1',
        title: 'Форма входа',
        createdAt: '2026-09-07T10:00:00.000Z',
        model: 'sonnet',
        effort: 'high',
        kind: 'implementation',
        lowered: true,
      });
    });

    it('запрос без модели продолжает на модели закрываемого разговора', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/chat/handoff',
        payload: { projectPath: project, chatId: 'sess-1', proposal: PROPOSAL },
      });

      expect(started[0]?.model).toBe('sonnet');
    });

    it('выбор человека в шапке сильнее наследства', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/chat/handoff',
        payload: { projectPath: project, chatId: 'sess-1', proposal: PROPOSAL, model: 'opus' },
      });

      expect(started[0]?.model).toBe('opus');
    });

    it('связь переезжает на продолжение — цепочка не съезжает на втором звене', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/chat/handoff',
        payload: { projectPath: project, chatId: 'sess-1', proposal: PROPOSAL },
      });

      const link = store.getChatLink(started[0]?.chatId ?? '');
      expect(link).toMatchObject({
        parentChatId: 'parent-1',
        model: 'sonnet',
        kind: 'implementation',
        lowered: true,
      });
    });

    it('у обычного разговора наследовать нечего — связи не заводим', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/chat/handoff',
        payload: { projectPath: project, chatId: 'обычный', proposal: PROPOSAL },
      });

      expect(started[0]?.model).toBe('claude-opus-5');
      expect(store.getChatLink(started[0]?.chatId ?? '')).toBeUndefined();
    });
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
    // Связь переносит владелец планировщика (`bootstrap/runtime.ts`); здесь она
    // подменена картой, чтобы проверить сам перенос, а не хранилище.
    const links = new Map<string, { model?: string }>();
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains,
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        contextLimit: () => contextLimit,
        stat: () => mtime,
        carryLink: (from, to) => {
          const link = from.map((key) => links.get(key)).find(Boolean);
          if (link) links.set(to, link);
        },
      }),
    );
    return { chains, registry, links };
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

  it('просьба словами («перезапустите сессию») продолжает так же, как блок', async () => {
    const { chains, registry } = build(
      'Этап закрыт. Перезапустите сессию. Новый прогон читает .agent/PROGRESS.md.',
      Date.now() + 10_000,
    );
    chains.setAuto(['чат-проза'], true);

    registry.start(
      'чат-проза',
      { prompt: 'Сделай экспорт отчётов', cwd: 'C:/work/проект' },
      { projectPath: 'C:/work/проект' },
    );
    await new Promise((done) => setTimeout(done, 20));

    const next = registry.active().find((run) => run.chatId.startsWith('new-'));
    expect(next).toBeDefined();
    // Исходное задание цепочки — реплика человека, с которой всё началось.
    // Заглушка прогона отвечает той же фразой и продолжению, поэтому цепочка
    // честно идёт дальше — но не за потолок и не теряя задания.
    expect(chains.rootTaskOf([next?.chatId ?? ''])).toBe('Сделай экспорт отчётов');
    expect(chains.depth([next?.chatId ?? ''])).toBeGreaterThanOrEqual(1);
    expect(chains.depth([next?.chatId ?? ''])).toBeLessThanOrEqual(HANDOFF_MAX_CHAIN);
  });

  it('«не перезапускай» продолжения не заводит', async () => {
    const { chains, registry } = build(
      'Не перезапускай сессию — я продолжаю здесь.',
      Date.now() + 10_000,
    );
    chains.setAuto(['чат-нет'], true);
    registry.start(
      'чат-нет',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      { projectPath: 'C:/work/проект' },
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(registry.active().some((run) => run.chatId.startsWith('new-'))).toBe(false);
  });

  it('файл-опора тот же, что при прошлом продолжении, — отказ «ходит по кругу»', async () => {
    const chains = new HandoffChains();
    const registry = new ChatRunRegistry(() => fakeRun(`Готово.\n\n${block(PROPOSAL)}`));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains,
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        stat: () => Date.now() + 10_000,
        hash: () => 'same',
      }),
    );
    // Прошлое продолжение оставило тот же отпечаток; тумблер — после связи, как
    // и в жизни: связь пишется при заведении, тумблер человек трогает потом.
    chains.link(['исходный'], 'чат-круг', { checkpointHash: 'same' });
    chains.setAuto(['чат-круг'], true);

    registry.start(
      'чат-круг',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      { projectPath: 'C:/work/проект' },
    );
    // Подписка — после старта: до него прогона нет и подписываться не на что.
    const seen = watch(registry, 'чат-круг');
    await new Promise((done) => setTimeout(done, 20));

    expect(seen.map((event) => event.reason)).toContain('checkpoint_unchanged');
    expect(registry.active().some((run) => run.chatId.startsWith('new-'))).toBe(false);
  });

  it('автопродолжение уносит с собой назначение — второе звено не съезжает', async () => {
    const { chains, registry, links } = build(
      `Готово.

${block(PROPOSAL)}`,
      Date.now() + 10_000,
    );
    chains.setAuto(['чат-1'], true);
    links.set('чат-1', { model: 'sonnet' });

    registry.start(
      'чат-1',
      { prompt: 'работай', cwd: 'C:/work/проект' },
      {
        projectPath: 'C:/work/проект',
      },
    );
    await new Promise((done) => setTimeout(done, 20));

    const next = registry
      .active()
      .map((run) => run.chatId)
      .find((id) => id.startsWith('new-'));
    // Сам прогон продолжения идёт теми же параметрами (они копируются целиком),
    // но СЛЕДУЮЩЕЕ сообщение человека придёт уже без модели — и без этой записи
    // уехало бы на дефолте посреди работы.
    expect(links.get(next ?? '')).toEqual({ model: 'sonnet' });
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

/**
 * Конвейер «работа → ревью → фикс» на живом реестре прогонов.
 *
 * Планировщик у реестра один, и звенья конвейера едут через него же: проверяется
 * не только то, ЧТО заводится, но и то, что оно заводится на правильной модели,
 * с правильной дописской и ровно один раз.
 */
describe('планировщик конвейера подбора модели', () => {
  const CWD = 'C:/work/проект-worktrees/rename';

  function fakeRun(text: string): RunLike {
    return {
      start: async (_options, onEvent) => {
        onEvent({ kind: 'text', text });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-работа' });
      },
      stop: () => undefined,
    };
  }

  function build(text: string, options: { hasWork?: boolean } = {}) {
    const chains = new HandoffChains();
    const registry = new ChatRunRegistry(() => fakeRun(text));
    const links = new Map<string, ChatLink>();
    const runs: { chatId: string; model?: string; effort?: string; append?: string }[] = [];
    // Реестр подменён не полностью: прогоны настоящие, а вот с чем их запустили
    // — видно только отсюда, поэтому старт перехватывается обёрткой.
    const start = registry.start.bind(registry);
    registry.start = (chatId, opts, meta) => {
      runs.push({
        chatId,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.appendSystemPrompt ? { append: opts.appendSystemPrompt } : {}),
      });
      return start(chatId, opts, meta);
    };

    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains,
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        cascade: {
          linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
          saveLink: (chatId, link) => void links.set(chatId, link),
          markReviewed: (aliases, at) => {
            for (const key of aliases) {
              const link = links.get(key);
              if (link) links.set(key, { ...link, reviewedAt: at });
            }
          },
          hasWork: () => options.hasWork ?? true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
      }),
    );
    return { chains, registry, links, runs };
  }

  const WORK_LINK: ChatLink = {
    parentChatId: 'родитель',
    createdAt: '2026-09-07T10:00:00.000Z',
    title: 'Переименования',
    branch: 'split/rename',
    model: 'sonnet',
    effort: 'medium',
    kind: 'mechanical',
    lowered: true,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
  };

  /** Прогон одного звена от старта до завершения планировщика. */
  async function run(registry: ChatRunRegistry, chatId: string): Promise<void> {
    registry.start(chatId, { prompt: 'переименуй foo в bar', cwd: CWD }, { projectPath: CWD });
    await new Promise((done) => setTimeout(done, 20));
  }

  it('после понижённой работы сам заводит ревью на потолке', async () => {
    const { registry, links, runs } = build('Готово, переименовал.');
    links.set('чат-работа', WORK_LINK);

    await run(registry, 'чат-работа');

    const review = runs.find((item) => item.chatId.startsWith('new-'));
    expect(review?.model).toBe('claude-opus-5');
    expect(review?.effort).toBe('high');
    // Планка сдачи работы в ревью не уезжает: она сказала бы проверяющему
    // ровно обратное тому, зачем его завели.
    expect(review?.append ?? '').not.toContain('НИЖЕ потолка');
    expect(links.get(review?.chatId ?? '')?.stage).toBe('review');
    // Отметка о проверке — на работе, по её собственному ключу.
    expect(links.get('чат-работа')?.reviewedAt).toBeTruthy();
  });

  it('пустой дифф не стоит прогона на потолке', async () => {
    const { registry, links, runs } = build('Ничего не понадобилось.', { hasWork: false });
    links.set('чат-работа', WORK_LINK);

    await run(registry, 'чат-работа');

    expect(runs.filter((item) => item.chatId.startsWith('new-'))).toHaveLength(0);
  });

  it('замечания ревью заводят правки обратно на модели работы', async () => {
    const verdict = ['```agentdeck:review', '{"findings":["поправь ChatSplit.ts:88"]}', '```'];
    const { registry, links, runs } = build(`Проверил.\n${verdict.join('\n')}`);
    links.set('чат-ревью', {
      ...WORK_LINK,
      stage: 'review',
      model: 'claude-opus-5',
      effort: 'high',
      lowered: false,
      workModel: 'sonnet',
      workEffort: 'medium',
    });

    await run(registry, 'чат-ревью');

    const fix = runs.find((item) => item.chatId.startsWith('new-'));
    expect(fix?.model).toBe('sonnet');
    expect(fix?.effort).toBe('medium');
    // Правки идут ниже потолка — планка сдачи им нужна.
    expect(fix?.append ?? '').toContain('НИЖЕ потолка');
    expect(links.get(fix?.chatId ?? '')?.stage).toBe('fix');
  });

  it('ревью без замечаний закрывает цепочку', async () => {
    const verdict = ['```agentdeck:review', '{"findings":[]}', '```'];
    const { registry, links, runs } = build(`Проверил.\n${verdict.join('\n')}`);
    links.set('чат-ревью', { ...WORK_LINK, stage: 'review', workModel: 'sonnet' });

    await run(registry, 'чат-ревью');

    expect(runs.filter((item) => item.chatId.startsWith('new-'))).toHaveLength(0);
  });

  /**
   * Ключевой предохранитель: человек дописал ребёнку второе сообщение, прогон
   * снова закончился успешно — и второй проверки той же работы быть не должно.
   */
  it('второе сообщение работе не заводит второе ревью', async () => {
    const { registry, links, runs } = build('И это тоже готово.');
    links.set('чат-работа', WORK_LINK);

    await run(registry, 'чат-работа');
    await run(registry, 'чат-работа');

    expect(runs.filter((item) => item.chatId.startsWith('new-'))).toHaveLength(1);
  });

  /**
   * Уровни (Т1) через тот же планировщик: план кончился — стартует работа
   * ровно один раз; разбор уходит конвейеру, а не в звенья; конец цепочки
   * группы доходит до конвейера с её связью.
   */
  describe('уровни разделения', () => {
    function buildLevels(text: string, options: { hasWork?: boolean } = {}) {
      const built = build(text);
      const planned: string[] = [];
      const ended: { branch?: string; ok: boolean }[] = [];
      const triaged: string[] = [];
      built.registry.setHandoffPlanner(
        createHandoffPlanner({
          runs: built.registry,
          chains: built.chains,
          session: new ChatSession(built.registry),
          selfBaseUrl: 'http://127.0.0.1:5178',
          cascade: {
            linkOf: (aliases) => aliases.map((key) => built.links.get(key)).find(Boolean),
            saveLink: (chatId, link) => void built.links.set(chatId, link),
            markReviewed: () => undefined,
            markPlanned: (aliases) => void planned.push(...aliases),
            hasWork: () => options.hasWork ?? true,
            settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
          },
          split: {
            onTriageFinished: (finished) => {
              triaged.push(finished.chatId);
              return { kind: 'notice', code: 'triageApplied', text: 'применён' };
            },
            onChainEnded: (link, ok) =>
              void ended.push({ ...(link.branch ? { branch: link.branch } : {}), ok }),
          },
        }),
      );
      return { ...built, planned, ended, triaged };
    }

    const PLAN_LINK: ChatLink = {
      ...WORK_LINK,
      stage: 'plan',
      model: 'claude-opus-5',
      effort: 'high',
      workModel: 'sonnet',
      workEffort: 'medium',
      task: 'переименуй foo в bar',
      owns: ['src/rename'],
    };

    it('после плана заводит работу на подобранной модели и помечает план отработанным', async () => {
      // Прогон-заглушка отвечает одним текстом всем: работе после плана тоже, и
      // без диффа её цепочка кончается сразу — так виден и конец цепочки.
      const { registry, links, runs, planned, ended } = buildLevels(
        'Готово.\n```agentdeck:plan\n## Шаги\n1. Найти foo\n```',
        { hasWork: false },
      );
      links.set('чат-план', PLAN_LINK);

      await run(registry, 'чат-план');

      const work = runs.find((item) => item.chatId.startsWith('new-'));
      expect(work?.model).toBe('sonnet');
      expect(work?.effort).toBe('medium');
      expect(work?.append).toContain('НИЖЕ потолка');
      expect(links.get(work?.chatId ?? '')).toMatchObject({ stage: 'work', lowered: true });
      expect(planned).toContain('чат-план');
      // План — не цепочка: конвейер узнаёт о конце РАБОТЫ, а не плана.
      expect(ended).toEqual([{ branch: 'split/rename', ok: true }]);
    });

    it('план без блока: работа стартует с пометкой, что плана нет', async () => {
      const { registry, links, runs } = buildLevels('Не разобрался.');
      links.set('чат-план', PLAN_LINK);
      const seen: { stage?: string; planMissing?: boolean }[] = [];
      registry.start('чат-план', { prompt: 'план', cwd: CWD }, { projectPath: CWD });
      registry.attach('чат-план', 0, {
        send: ({ event }) => {
          if (event.kind === 'handoff') {
            seen.push({
              ...(event.stage ? { stage: event.stage } : {}),
              ...(event.planMissing ? { planMissing: true } : {}),
            });
          }
        },
        close: () => undefined,
      });
      await new Promise((done) => setTimeout(done, 20));

      expect(runs.some((item) => item.chatId.startsWith('new-'))).toBe(true);
      expect(seen).toEqual([{ stage: 'work', planMissing: true }]);
    });

    it('разбор идёт конвейеру, а не в звенья', async () => {
      const { registry, links, runs, triaged } = buildLevels('Развёл.');
      links.set('чат-разбор', { ...WORK_LINK, stage: 'triage', branch: undefined as never });

      await run(registry, 'чат-разбор');

      expect(triaged).toEqual(['чат-разбор']);
      expect(runs.filter((item) => item.chatId.startsWith('new-'))).toEqual([]);
    });

    it('конец цепочки группы доходит до конвейера: работа на потолке — сразу, правки — тоже', async () => {
      const { registry, links, ended } = buildLevels('Сделал.');
      links.set('чат-работа', { ...WORK_LINK, lowered: false });
      links.set('чат-правки', { ...WORK_LINK, stage: 'fix', branch: 'split/fix' });

      await run(registry, 'чат-работа');
      await run(registry, 'чат-правки');

      expect(ended).toEqual([
        { branch: 'split/rename', ok: true },
        { branch: 'split/fix', ok: true },
      ]);
    });
  });
});
