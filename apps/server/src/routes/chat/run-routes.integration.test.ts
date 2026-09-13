import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlatformRunConsumer } from '@agentdeck/contracts/platform-consumers';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts.ts';
import { registerChatRunRoutes } from './run-routes.ts';

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
  const PLAIN = 'run-origin-plain';
  const CHILD = 'run-origin-child';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-run-origin-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    asked = [];
    store = new AppStore(join(root, 'agentdeck'));
    // Прогон-заглушка: называет сессию и сразу заканчивается, иначе поток SSE
    // остался бы открытым и запрос не вернулся бы вовсе.
    registry = new ChatRunRegistry((): RunLike => ({
      start: (options, onEvent) => {
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
});
