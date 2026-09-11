import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatDetail, ProviderChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from '../domains/provider-chat.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * Маршруты чата чужого провайдера. Настоящий CLI не запускается: прогон подменён.
 * Главное, что проверяется на уровне HTTP, — что при активном Claude сюда не
 * пройти, что разговоры принадлежат активному провайдеру, и что отказы приходят
 * понятным кодом, а не 500.
 */

/** Прогон, управляемый тестом. */
class FakeRun implements ProviderChatRunLike {
  static last: FakeRun | undefined;
  emit: ((event: ProviderChatRunEvent) => void) | undefined;

  constructor() {
    FakeRun.last = this;
  }

  start(_options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.emit = onEvent;
    return new Promise<void>(() => {
      // Ответ завершает тест, вызывая emit — сам по себе прогон не кончается.
    });
  }

  stop(): void {}
}

function makeCtx(root: string, provider: string): ServerContext {
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData } },
    store,
    models: { current: () => ({ models: [] }) },
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

describe('provider-chat роуты', () => {
  let root: string;
  let app: FastifyInstance;
  let chats: ProviderChatService;

  const boot = async (provider: string): Promise<void> => {
    app = Fastify();
    chats = new ProviderChatService(() => new FakeRun());
    registerProviderChatRoutes(app, makeCtx(root, provider), chats, new HandoffChains());
    await app.ready();
  };

  const createChat = async (): Promise<ProviderChatSummary> => {
    const res = await app.inject({ method: 'POST', url: '/api/provider-chat/chats', payload: {} });
    return res.json<ProviderChatSummary>();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-pchat-route-'));
    FakeRun.last = undefined;
  });

  afterEach(async () => {
    chats?.stopAll();
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('при активном Claude все маршруты закрыты — у него свой чат', async () => {
    await boot('claude');

    const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    const create = await app.inject({
      method: 'POST',
      url: '/api/provider-chat/chats',
      payload: {},
    });

    expect(list.statusCode).toBe(400);
    expect(create.statusCode).toBe(400);
    expect(list.json<{ message: string }>().message).toMatch(/Claude/);
  });

  it('создаёт разговор и отдаёт его в списке', async () => {
    await boot('codex');
    const chat = await createChat();

    const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    expect(list.statusCode).toBe(200);
    expect(list.json<ProviderChatSummary[]>().map((item) => item.id)).toEqual([chat.id]);
    expect(chat.providerId).toBe('codex');
  });

  it('разговоры не видны из-под другого провайдера', async () => {
    await boot('codex');
    await createChat();
    await app.close();

    await boot('gemini');
    const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    expect(list.json<ProviderChatSummary[]>()).toEqual([]);
  });

  it('несуществующий разговор — 404, а не пустой ответ', async () => {
    await boot('codex');

    const read = await app.inject({ method: 'GET', url: '/api/provider-chat/chats/nope' });
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/provider-chat/chats/nope',
      payload: { title: 'Э' },
    });
    const remove = await app.inject({ method: 'DELETE', url: '/api/provider-chat/chats/nope' });

    expect([read.statusCode, patch.statusCode, remove.statusCode]).toEqual([404, 404, 404]);
  });

  it('переименовывает и удаляет разговор', async () => {
    await boot('codex');
    const chat = await createChat();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/provider-chat/chats/${chat.id}`,
      payload: { title: 'Сборка' },
    });
    expect(patch.json<ProviderChatSummary>().title).toBe('Сборка');

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/provider-chat/chats/${chat.id}`,
    });
    expect(remove.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    expect(list.json<ProviderChatSummary[]>()).toEqual([]);
  });

  it('несуществующий рабочий каталог — 400 с человеческим текстом', async () => {
    await boot('codex');

    const res = await app.inject({
      method: 'POST',
      url: '/api/provider-chat/chats',
      payload: { workdir: join(root, 'нет-такого') },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/не существует/);
  });

  it('вопрос возвращает записанную реплику, не дожидаясь ответа', async () => {
    await boot('codex');
    const chat = await createChat();

    const res = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'Почини сборку' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ message: { content: string } }>().message.content).toBe('Почини сборку');

    const detail = await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${chat.id}` });
    expect(detail.json<ProviderChatDetail>().messages).toHaveLength(1);
  });

  it('пустой вопрос отклоняется', async () => {
    await boot('codex');
    const chat = await createChat();

    const res = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: '   ' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('второй вопрос поверх идущего ответа — 409', async () => {
    await boot('codex');
    const chat = await createChat();
    const ask = { method: 'POST' as const, url: `/api/provider-chat/chats/${chat.id}/send` };

    await app.inject({ ...ask, payload: { text: 'Первый' } });
    const second = await app.inject({ ...ask, payload: { text: 'Второй' } });

    expect(second.statusCode).toBe(409);
  });

  it('вопрос в несуществующий разговор — 404', async () => {
    await boot('codex');

    const res = await app.inject({
      method: 'POST',
      url: '/api/provider-chat/chats/nope/send',
      payload: { text: 'Э' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('состояние показывает уже напечатанное — этим вкладка догоняет пропущенное', async () => {
    await boot('codex');
    const chat = await createChat();
    await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'Вопрос' },
    });

    FakeRun.last?.emit?.({ type: 'delta', text: 'Половина' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/provider-chat/chats/${chat.id}/status`,
    });
    expect(res.json()).toMatchObject({ isRunning: true, partial: 'Половина' });
  });

  it('остановка гасит идущий ответ и честно отвечает, когда гасить нечего', async () => {
    await boot('codex');
    const chat = await createChat();
    const stopUrl = `/api/provider-chat/chats/${chat.id}/stop`;

    const idle = await app.inject({ method: 'POST', url: stopUrl });
    expect(idle.json<{ stopped: boolean }>().stopped).toBe(false);

    await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'Вопрос' },
    });
    const running = await app.inject({ method: 'POST', url: stopUrl });
    expect(running.json<{ stopped: boolean }>().stopped).toBe(true);
  });

  it('готовый ответ дописывается в переписку', async () => {
    await boot('codex');
    const chat = await createChat();
    await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'Вопрос' },
    });

    FakeRun.last?.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

    const detail = await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${chat.id}` });
    expect(detail.json<ProviderChatDetail>().messages.map((message) => message.content)).toEqual([
      'Вопрос',
      'Готово',
    ]);
  });

  /**
   * «Перезапустить сессию» у чужого CLI (Т7). Сессии у него нет, поэтому кнопка
   * заводит НОВЫЙ разговор в том же каталоге. Ответа два, и оба важны: файл-опора
   * свежий — продолжение стартует сразу, несвежий — панель просит его обновить, а
   * не молча делает вид, что перезапустила.
   */
  describe('перезапуск разговора', () => {
    /** Разговор с копией на диске и одной репликой человека. */
    const chatWithWork = async (checkpointAt: 'fresh' | 'stale'): Promise<ProviderChatSummary> => {
      const workdir = join(root, 'repo');
      mkdirSync(join(workdir, '.agent'), { recursive: true });
      const checkpoint = join(workdir, '.agent', 'PROGRESS.md');
      const res = await app.inject({
        method: 'POST',
        url: '/api/provider-chat/chats',
        payload: { workdir },
      });
      const chat = res.json<ProviderChatSummary>();
      await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/send`,
        payload: { text: 'Переименуй foo в bar' },
      });
      FakeRun.last?.emit?.({ type: 'done', reply: 'Сделал часть', transport: 'stream' });
      writeFileSync(checkpoint, '# состояние', 'utf8');
      // Время правки задаётся явно: миллисекунды реплики и файла иначе совпали
      // бы, и «несвежий» случай не воспроизводился бы вовсе.
      const when = checkpointAt === 'fresh' ? Date.now() + 60_000 : Date.now() - 60_000;
      utimesSync(checkpoint, when / 1000, when / 1000);
      return chat;
    };

    it('свежий файл-опора — продолжение заводится сразу, новым разговором', async () => {
      await boot('codex');
      const chat = await chatWithWork('fresh');

      const res = await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/restart`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ mode: string; chatId: string }>();
      expect(body.mode).toBe('started');

      const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
      const next = list.json<ProviderChatSummary[]>().find((item) => item.id === body.chatId);
      expect(next?.title).toMatch(/продолжение/);
      expect(next?.workdir).toBe(join(root, 'repo'));

      // В старом разговоре осталась заметка: человек вернётся именно в него.
      const detail = await app.inject({
        method: 'GET',
        url: `/api/provider-chat/chats/${chat.id}`,
      });
      const last = detail.json<ProviderChatDetail>().messages.at(-1);
      expect(last?.role).toBe('notice');
      expect(last?.content).toContain('сессии у CLI нет');
    });

    it('несвежий файл-опора — панель просит его обновить, а не перезапускает', async () => {
      await boot('codex');
      const chat = await chatWithWork('stale');

      const res = await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/restart`,
      });

      const body = res.json<{ mode: string; prompt: string }>();
      expect(body.mode).toBe('requested');
      expect(body.prompt).toContain('.agent/PROGRESS.md');

      // Новый разговор при этом НЕ заведён: перезапускать не по чему.
      const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
      expect(list.json<ProviderChatSummary[]>()).toHaveLength(1);
    });

    it('пока идёт ответ — 409, а не второй разговор', async () => {
      await boot('codex');
      const chat = await chatWithWork('fresh');
      await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/send`,
        payload: { text: 'ещё' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/restart`,
      });

      expect(res.statusCode).toBe(409);
    });

    it('разговор без рабочего каталога перезапускать негде', async () => {
      await boot('codex');
      const chat = await createChat();

      const res = await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${chat.id}/restart`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/рабочего каталога/);
    });
  });
});
