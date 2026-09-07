import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ModelInfo } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerChatSplitRoutes } from './chat/split-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import {
  ProviderChatService,
  listChats,
  readChat,
  type ProviderChatRunOptions,
} from '../domains/provider-chat.ts';

/**
 * Разделение задач, когда активен ЧУЖОЙ провайдер (Т12).
 *
 * Отдельный файл от разделения у Claude, потому что здесь другой весь путь:
 * разговор заводит хранилище провайдера, прогон идёт одноразовым запуском CLI, а
 * модель подбирается по лестнице провайдера, а не от потолка разговора.
 *
 * Настоящий CLI при этом не запускается: подменяется фабрика прогона службы —
 * ровно та же точка, в которой её подменяют собственные тесты службы. Проверяется
 * то, что уедет в argv (модель и глубина), название разговора и память шапки.
 */
describe('POST /api/chat/split — чужой провайдер', () => {
  let root: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let appData: string;
  let providerChats: ProviderChatService;
  let runs: ProviderChatRunOptions[];

  const catalog = [
    { id: 'gpt-5.3-codex-spark', name: 'spark', family: 'gpt-codex-spark', releaseDate: '2026-02' },
    { id: 'gpt-5.3-codex', name: 'codex', family: 'gpt-codex', releaseDate: '2026-02' },
  ] as unknown as ModelInfo[];

  const proposal = {
    groups: [
      { title: 'Переименования', branch: 'split/rename', tasks: ['раз'], kind: 'mechanical' },
      { title: 'Архитектура', branch: 'split/design', tasks: ['два'], kind: 'design' },
    ],
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-foreign-'));
    project = mkdtempSync(join(tmpdir(), 'cc-split-foreign-proj-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });

    runs = [];
    providerChats = new ProviderChatService(() => ({
      start: async (options, onEvent) => {
        runs.push(options);
        onEvent({ type: 'done', reply: 'готово', transport: 'stream' });
      },
      stop: () => undefined,
    }));

    store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });

    const ctx = {
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      store,
      backupDir: join(appData, 'backups'),
      models: { current: () => ({ models: catalog }) },
    } as unknown as ServerContext;

    app = Fastify();
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async () => undefined,
      stop: () => undefined,
    }));
    registerChatSplitRoutes(app, ctx, {
      runs: registry,
      providerChats,
      session: new ChatSession(registry),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const split = async (): Promise<{
    chats: { title: string; started: boolean; model?: string; kind?: string }[];
  }> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: { projectPath: project, proposal, startRuns: true, parentChatId: 'родитель' },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  it('механика едет младшей ступенью лестницы, а класс-потолок — без модели', async () => {
    const body = await split();

    expect(body.chats.map((chat) => chat.model)).toEqual(['gpt-5.3-codex-spark', undefined]);
    expect(runs).toHaveLength(2);
    // Ровно то, что уедет в argv: модель у понижённой группы и НИЧЕГО у той,
    // которой положен потолок, — потолок у чужого CLI это его настройка.
    expect(runs[0]?.model).toBe('gpt-5.3-codex-spark');
    expect(runs[0]?.effort).toBe('medium');
    expect(runs[1]?.model).toBe(undefined);
    expect(runs[1]?.effort).toBe(undefined);
  });

  it('понижённой группе дописывается планка сдачи, группе на потолке — нет', async () => {
    await split();

    expect(runs[0]?.systemPrefix).toContain('НИЖЕ потолка');
    // Обещания ревью в задании быть не должно: у чужого провайдера конвейер не
    // работает, и агент, рассчитывающий на вторую пару глаз, проверит себя хуже.
    expect(runs[0]?.systemPrefix).toContain('Ревью этой работы панель не заведёт');
    expect(runs[1]?.systemPrefix ?? '').not.toContain('НИЖЕ потолка');
  });

  it('разговор называется группой, а не служебным ключом', async () => {
    await split();

    const titles = listChats(appData, 'codex').map((chat) => chat.title);
    expect(titles).toEqual(expect.arrayContaining(['Переименования', 'Архитектура']));
    expect(titles.some((title) => title.startsWith('new-'))).toBe(false);
  });

  it('назначение помнится шапкой разговора и действует на следующее сообщение', async () => {
    await split();

    const chat = listChats(appData, 'codex').find((item) => item.title === 'Переименования');
    expect(chat?.model).toBe('gpt-5.3-codex-spark');

    // Второе сообщение приходит БЕЗ назначения (телефон и API его не шлют) —
    // модель обязана взяться из шапки, иначе работа продолжилась бы не тем, чем
    // началась.
    providerChats.send(appData, 'codex', chat?.id ?? '', { text: 'дальше' }, {
      provider: { id: 'codex' },
    } as unknown as Parameters<ProviderChatService['send']>[4]);

    expect(runs.at(-1)?.model).toBe('gpt-5.3-codex-spark');
    expect(runs.at(-1)?.effort).toBe('medium');
  });

  it('связь с родителем чужому чату не пишется — ключа, под которым её искать, нет', async () => {
    await split();

    // Связь под временным ключом `new-…` была бы записью о разговоре, которого не
    // существует: у чужого CLI идентификатор выдаёт его собственное хранилище.
    expect(store.getChatLink('родитель')).toBe(undefined);
    for (const chat of listChats(appData, 'codex')) {
      expect(store.getChatLink(chat.id)).toBe(undefined);
    }
  });

  it('выключенный в проекте подбор отменяет и подбор у чужого провайдера', async () => {
    store.setProjectCascade(project, false);

    const body = await split();

    expect(body.chats.every((chat) => chat.model === undefined)).toBe(true);
    expect(runs.every((run) => run.model === undefined)).toBe(true);
    // Первый вопрос всё равно записан в переписку — выключен подбор, а не чат.
    expect(
      readChat(appData, 'codex', listChats(appData, 'codex')[0]?.id ?? '')?.messages,
    ).toHaveLength(2);
  });
});
