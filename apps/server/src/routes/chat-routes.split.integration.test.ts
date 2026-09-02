import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';

/**
 * Маршрут разделения задач по чатам. Каталог берём обычный (не репозиторий) —
 * тогда проверяется именно склейка «маршрут → домен → реестр прогонов», без
 * настоящего git: копии заводятся его собственным тестом.
 */
describe('POST /api/chat/split', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let started: { chatId: string; prompt: string; cwd: string; appendSystemPrompt?: string }[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-proj-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    started = [];
    // Прогон-заглушка: запоминает запуск и немедленно завершается, чтобы реестр
    // не держал висящих процессов между тестами.
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options) => {
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          prompt: options.prompt,
          cwd: options.cwd,
          ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
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
    registerChatSplitRoutes(app, ctx, { runs: registry, providerChats: new ProviderChatService() });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const proposal = {
    shared: 'Общее',
    groups: [
      { title: 'Раз', branch: 'feature/one', tasks: ['первая задача'] },
      { title: 'Два', branch: 'feature/two', tasks: ['вторая задача'] },
    ],
  };

  it('заводит по чату на группу и запускает прогоны', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { chats: { started: boolean; path: string }[] };
    expect(body.chats).toHaveLength(2);
    expect(body.chats.every((chat) => chat.started)).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[0]?.prompt).toContain('первая задача');
    expect(started[0]?.prompt).toContain('Общее');
  });

  it('набор, привязанный к проекту, включается и для порождённых чатов', async () => {
    // Прогон здесь заводит не отправка из поля ввода, а сам маршрут: без этого
    // правила и скиллы набора доехали бы только со следующего сообщения,
    // набранного руками, — то есть агент стартовал бы не с тем окружением.
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
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    expect(store.getGroups()[0]?.isEnabled).toBe(true);
  });

  it('«только завести чаты» не запускает ни одного прогона', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: false },
    });

    expect(response.statusCode).toBe(200);
    expect(started).toHaveLength(0);
    const body = response.json() as { chats: { prompt: string }[] };
    expect(body.chats[0]?.prompt).toContain('первая задача');
  });

  it('без каталога проекта — отказ, а не чаты неизвестно где', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { proposal, startRuns: true },
    });

    expect(response.statusCode).toBe(400);
  });

  it('предложение из одной группы — отказ: это не разделение', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: {
        projectPath: project,
        proposal: { groups: [{ title: 'Одна', branch: 'a', tasks: ['x'] }] },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('порождённый чат получает продолжение, но делиться дальше не предлагает', async () => {
    // Чат, только что выделенный под ОДНУ группу, уже разделён: предлагать ему
    // дробиться снова значит спрашивать то же самое по второму разу, и сразу в
    // шести местах — так живые прогоны и вышли. Продолжение в чистой сессии —
    // другое решение и другой тумблер, его человек включал отдельно, и молча
    // отключаться во всех порождённых чатах оно не должно.
    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    const appended = started[0]?.appendSystemPrompt ?? '';
    expect(appended).not.toContain('claude-control:split');
    expect(appended).toContain('claude-control:handoff');
    // Одна строка: перевод строки внутри аргумента рвёт командную строку cmd.exe.
    expect(appended).not.toMatch(/[\r\n]/);
  });

  it('выключенная инициатива в порождённый чат не уходит', async () => {
    // Разделение здесь и так молчит, продолжение выключено тумблером — из
    // склейки остаётся только правило про вопрос человеку, у которого тумблера
    // нет и быть не должно.
    store.updateSettings({ handoffInitiative: false });

    await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true },
    });

    const appended = started[0]?.appendSystemPrompt ?? '';
    expect(appended).not.toContain('claude-control:split');
    expect(appended).not.toContain('claude-control:handoff');
    expect(appended).toContain('AskUserQuestion');
  });

  /**
   * Отказ «работаем здесь» гасит инициативу и в РОДИТЕЛЬСКОМ разговоре: реплика
   * отказа живёт один ход, а инструкция дописывается к каждому прогону.
   */
  it('отказ от разделения помечает разговор', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split/decline',
      payload: { chatId: 'chat-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(registry.isSplitMuted('chat-1')).toBe(true);
    expect(registry.isSplitMuted('chat-2')).toBe(false);
  });

  it('текст просьбы отдаётся сервером — второй копии инструкции в клиенте нет', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/split/request' });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { prompt: string }).prompt).toContain('claude-control:split');
  });
});
