import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProviderChatDetail,
  ProviderChatQueued,
  ProviderChatStatus,
  ProviderChatSummary,
} from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { ProviderChatService } from '../domains/provider-chat.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from '../domains/provider-chat.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * Очередь чата чужого CLI через настоящие маршруты: отправка занятому
 * разговору с `queueIfBusy` — 202 с элементом очереди, а не 409; статус её
 * показывает, отмена снимает, конец ответа отпускает. Подменён только процесс.
 */

const runs: { emit: (event: ProviderChatRunEvent) => void; prompt: string }[] = [];

class ManualRun implements ProviderChatRunLike {
  start(
    options: { history: { content: string }[] },
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    runs.push({ emit: onEvent, prompt: options.history.at(-1)?.content ?? '' });
    return new Promise<void>(() => {});
  }

  stop(): void {}
}

describe('чужой CLI: очередь занятого разговора через маршруты', () => {
  let root: string;
  let app: FastifyInstance;
  let chats: ProviderChatService;

  beforeEach(async () => {
    runs.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cc-pqueue-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });
    chats = new ProviderChatService(() => new ManualRun() as unknown as ProviderChatRunLike);
    app = Fastify();
    const ctx = {
      location: { paths: { root, appData } },
      store,
      models: { current: () => ({ models: [] }) },
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;
    registerProviderChatRoutes(app, ctx, chats, new HandoffChains());
    await app.ready();
  });

  afterEach(async () => {
    chats.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function busyChat(): Promise<string> {
    const chat = (
      await app.inject({ method: 'POST', url: '/api/provider-chat/chats', payload: {} })
    ).json<ProviderChatSummary>();
    const first = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'первый' },
    });
    expect(first.statusCode).toBe(200);
    return chat.id;
  }

  const status = async (id: string): Promise<ProviderChatStatus> =>
    (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}/status` })
    ).json<ProviderChatStatus>();

  it('без флага занятый разговор по-прежнему отказывает 409', async () => {
    const id = await busyChat();
    const second = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/send`,
      payload: { text: 'второй' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('с queueIfBusy — 202 и элемент очереди; конец ответа отправляет его сам', async () => {
    const id = await busyChat();
    const second = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/send`,
      payload: { text: 'второй', queueIfBusy: true },
    });
    expect(second.statusCode).toBe(202);
    const { queued } = second.json<{ queued: ProviderChatQueued }>();
    expect(queued.text).toBe('второй');
    expect((await status(id)).queued).toEqual([queued]);

    runs[0]!.emit({ type: 'done', reply: 'ответ', transport: 'stream' });
    expect(runs[1]!.prompt).toContain('второй');
    const after = await status(id);
    expect(after.isRunning).toBe(true);
    expect(after.queued).toBeUndefined();
    const detail = (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}` })
    ).json<ProviderChatDetail>();
    expect(detail.messages.map((item) => item.content)).toEqual(['первый', 'ответ', 'второй']);
  });

  it('свободному разговору queueIfBusy ничего не меняет — уходит сразу', async () => {
    const chat = (
      await app.inject({ method: 'POST', url: '/api/provider-chat/chats', payload: {} })
    ).json<ProviderChatSummary>();
    const sent = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'сразу', queueIfBusy: true },
    });
    expect(sent.statusCode).toBe(200);
    expect(runs).toHaveLength(1);
  });

  it('отмена снимает сообщение; повторная — cancelled: false', async () => {
    const id = await busyChat();
    const { queued } = (
      await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${id}/send`,
        payload: { text: 'передумал', queueIfBusy: true },
      })
    ).json<{ queued: ProviderChatQueued }>();
    const url = `/api/provider-chat/chats/${id}/queue/${queued.id}`;

    expect((await app.inject({ method: 'DELETE', url })).json()).toEqual({ cancelled: true });
    expect((await app.inject({ method: 'DELETE', url })).json()).toEqual({ cancelled: false });
    runs[0]!.emit({ type: 'done', reply: 'ответ', transport: 'stream' });
    expect(runs).toHaveLength(1);
  });

  // Ф13: перезапуск панели снимал идущий ответ вместе с очередью — написанное
  // человеком пропадало. Теперь новая панель видит её ждущей и шлёт по кнопке.
  it('после перезапуска очередь «ждёт отправки», кнопка её шлёт; второй раз — 404', async () => {
    const id = await busyChat();
    const { queued } = (
      await app.inject({
        method: 'POST',
        url: `/api/provider-chat/chats/${id}/send`,
        payload: { text: 'до перезапуска', queueIfBusy: true },
      })
    ).json<{ queued: ProviderChatQueued }>();

    // «Перезапуск»: новый сервис и новые маршруты над тем же каталогом данных.
    chats.stopAll();
    await app.close();
    const appData = join(root, 'agentdeck');
    const store = new AppStore(appData);
    chats = new ProviderChatService(() => new ManualRun() as unknown as ProviderChatRunLike);
    app = Fastify();
    registerProviderChatRoutes(
      app,
      {
        location: { paths: { root, appData } },
        store,
        models: { current: () => ({ models: [] }) },
        backupDir: join(appData, 'backups'),
      } as unknown as ServerContext,
      chats,
      new HandoffChains(),
    );
    await app.ready();

    expect(await status(id)).toMatchObject({
      isRunning: false,
      queueHeld: true,
      queued: [expect.objectContaining({ id: queued.id, text: 'до перезапуска' })],
    });
    const before = runs.length;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/queue/${queued.id}/send`,
    });
    expect(sent.statusCode).toBe(200);
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)!.prompt).toContain('до перезапуска');
    expect((await status(id)).queued).toBeUndefined();

    runs.at(-1)!.emit({ type: 'done', reply: 'ответ', transport: 'stream' });
    const again = await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/queue/${queued.id}/send`,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ messageCode: 'foreign-queued-gone' });
  });
});
