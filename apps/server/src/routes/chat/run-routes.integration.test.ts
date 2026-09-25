import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlatformRunConsumer } from '@agentdeck/contracts/platform-consumers';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { AUTONOMOUS_PERMISSION_MODE } from '../../domains/chat/ChatWorkspace.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { stageAppendPrompt } from '../../domains/chat/ChatCascadeStages.ts';

/**
 * Отправка сообщения поверх НАСТОЯЩЕГО маршрута: чем именно прогон спрашивает
 * маршрут контура (Т3, потребители). Заглушен только сам CLI — всё остальное
 * (тело запроса, рабочая папка, реестр) настоящее, потому что вопрос ровно в
 * том, что доедет до реестра из HTTP-запроса.
 */
describe('маршрут отправки: потребитель контура', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let asked: PlatformRunConsumer[];
  let prompts: (string | undefined)[];
  let modes: (string | undefined)[];
  const PLAIN = 'run-origin-plain';
  const CHILD = 'run-origin-child';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-run-origin-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    asked = [];
    prompts = [];
    modes = [];
    store = new AppStore(join(root, 'agentdeck'));
    // Прогон-заглушка: называет сессию и сразу заканчивается, иначе поток SSE
    // остался бы открытым и запрос не вернулся бы вовсе.
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
        prompts.push(options.appendSystemPrompt);
        modes.push(options.permissionMode);
        onEvent({
          kind: 'session',
          sessionId: options.sessionId ?? 'sess',
          model: options.model ?? '',
          tools: 0,
        });
        return Promise.resolve();
      },
      stop: () => undefined,
    }));
    registry.setPlatformRouting((origin) => {
      asked.push(origin);
      return { env: {} };
    });
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    // Папку вложений маршрут заводит в домашнем каталоге на каждую отправку —
    // за собой убираем, чужого там не трогаем.
    for (const id of [PLAIN, CHILD])
      rmSync(join(sandboxRoot(), id), { recursive: true, force: true });
  });

  const send = (chatId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt: 'привет', projectPath: join(root, 'work') },
    });

  it('обычный разговор идёт потребителем «Чат»', async () => {
    const response = await send(PLAIN);

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual(['chat']);
  });

  it('разговор со связью разделения идёт потребителем «Группы»', async () => {
    // Связь заводит разделение; здесь она уже есть — как у ребёнка, которому
    // человек пишет руками вторым сообщением.
    store.setChatLink(CHILD, {
      parentChatId: 'parent',
      title: 'группа',
      createdAt: new Date().toISOString(),
    });

    const response = await send(CHILD);

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual(['groups']);
  });

  describe('режим прав ответа человека', () => {
    const sendEdits = (chatId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: { chatId, prompt: 'да', projectPath: join(root, 'work'), allowEdits: true },
      });

    it('ответ в чате группы продолжает её в авторежиме, а не в acceptEdits', async () => {
      // Живой прогон 24.09.2026: ответ человека в группе поднимал её в
      // `acceptEdits`, и она вставала на карточке прав, которой не видно.
      store.setChatLink(CHILD, {
        parentChatId: 'parent',
        title: 'группа',
        createdAt: new Date().toISOString(),
      });

      await sendEdits(CHILD);

      expect(modes).toEqual([AUTONOMOUS_PERMISSION_MODE]);
    });

    it('обычный чат с правом правок по умолчанию идёт в авторежиме CLI', async () => {
      // Владелец, 24.09.2026: в `acceptEdits` отдельная задача вставала на
      // карточке ради `git status`. По умолчанию — как авторежим Claude Code.
      await sendEdits(PLAIN);

      expect(modes).toEqual([AUTONOMOUS_PERMISSION_MODE]);
    });
  });

  // Живой прогон 25.09 (O1): ответ человека в чат группы получал инструкцию
  // предложить разделение и потому не совпадал подписью с живым процессом звена
  // — каждый ответ шёл холодным `--resume`, ~30 с до CLI.
  it('ответ человека в чат группы несёт дописку её звена, без инициативы разделения', async () => {
    const link = {
      parentChatId: 'parent',
      title: 'группа',
      stage: 'work' as const,
      kind: 'mechanical',
      lowered: true,
      createdAt: new Date().toISOString(),
    };
    store.setChatLink(CHILD, link);

    const response = await send(CHILD);

    expect(response.statusCode).toBe(200);
    expect(prompts[0] ?? '').not.toContain('agentdeck:split');
    expect(prompts[0]).toBe(stageAppendPrompt({ stage: 'work', link }, store.getSettings()));
  });

  describe('доставка до MR', () => {
    // Доставка действует только там, где MR есть куда создать: репозиторий с
    // удалённым. Сам удалённый не нужен — git отвечает по записи в конфиге.
    beforeEach(() => {
      const work = join(root, 'work');
      execFileSync('git', ['init', '-b', 'main'], { cwd: work });
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'], {
        cwd: work,
      });
    });

    it('обычный чат проекта получает строку доставки', async () => {
      const response = await send(PLAIN);

      expect(response.statusCode).toBe(200);
      expect(prompts[0]).toContain('Доставка до MR на этом проекте включена');
    });

    it('ребёнок разделения её не получает: доставка — в задании группы', async () => {
      store.setChatLink(CHILD, {
        parentChatId: 'parent',
        title: 'группа',
        createdAt: new Date().toISOString(),
      });

      const response = await send(CHILD);

      expect(response.statusCode).toBe(200);
      expect(prompts[0] ?? '').not.toContain('Доставка до MR');
    });
  });
});
