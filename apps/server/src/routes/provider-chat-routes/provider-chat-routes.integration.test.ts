import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatDetail, ProviderChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { appendMessage, createChat } from '../../domains/provider-chat/store/store.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * @covers routes/provider-chat-routes/provider-chat-routes.ts
 * @scenario старый разговор чужого CLI после переезда чата на ядро (этап 10, F2c): история
 *   читается, переименовывается и удаляется; любой маршрут прежнего исполнителя (ход,
 *   остановка, перезапуск, очередь, ответ на запрос прав, состояние, поток, новый разговор)
 *   отвечает 410 с кодом `provider-chat-core` и ничего не пишет на диск.
 */

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

const RETIRED: Array<['GET' | 'POST' | 'DELETE', string]> = [
  ['POST', '/api/provider-chat/chats'],
  ['POST', '/api/provider-chat/chats/old/send'],
  ['POST', '/api/provider-chat/chats/old/restart'],
  ['POST', '/api/provider-chat/chats/old/stop'],
  ['DELETE', '/api/provider-chat/chats/old/queue/q1'],
  ['POST', '/api/provider-chat/chats/old/queue/q1/send'],
  ['POST', '/api/provider-chat/chats/old/permissions/a1'],
  ['GET', '/api/provider-chat/chats/old/status'],
  ['GET', '/api/provider-chat/chats/old/stream'],
];

describe('provider-chat history routes', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;

  const boot = async (provider: string): Promise<void> => {
    app = Fastify();
    ctx = makeCtx(root, provider);
    registerProviderChatRoutes(app, ctx);
    await app.ready();
  };
  const appData = () => ctx.location.paths.appData;
  const seed = () => {
    createChat(appData(), 'codex', { id: 'old', title: 'старый', workdir: root });
    appendMessage(appData(), 'codex', 'old', { role: 'user', content: 'привет' });
    appendMessage(appData(), 'codex', 'old', { role: 'assistant', content: 'ответ' });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-provider-chat-history-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('lists and reads an old conversation of the active CLI', async () => {
    await boot('codex');
    seed();
    const list = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    expect(list.statusCode).toBe(200);
    expect(list.json<ProviderChatSummary[]>().map((c) => c.id)).toEqual(['old']);
    const one = await app.inject({ method: 'GET', url: '/api/provider-chat/chats/old' });
    expect(one.json<ProviderChatDetail>().messages.map((m) => m.content)).toEqual([
      'привет',
      'ответ',
    ]);
  });

  it('renames and deletes; only the title is patched', async () => {
    await boot('codex');
    seed();
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/provider-chat/chats/old',
      payload: { title: 'новое имя', workdir: '', allowEdits: true },
    });
    expect(patched.statusCode).toBe(200);
    const detail = patched.json<ProviderChatDetail>();
    expect(detail.title).toBe('новое имя');
    expect(detail.workdir).toBe(root);
    expect(detail.allowEdits).not.toBe(true);
    const gone = await app.inject({ method: 'DELETE', url: '/api/provider-chat/chats/old' });
    expect(gone.json()).toEqual({ ok: true });
    const again = await app.inject({ method: 'GET', url: '/api/provider-chat/chats/old' });
    expect(again.statusCode).toBe(404);
  });

  it.each(RETIRED)('%s %s refuses by name and writes nothing', async (method, url) => {
    await boot('codex');
    seed();
    const before = readdirSync(join(appData(), 'provider-chats', 'codex')).sort();
    const res = await app.inject({ method, url, payload: { text: 'ещё' } });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ messageCode: 'provider-chat-core' });
    expect(res.json<{ message: string }>().message).toContain('ядро');
    expect(readdirSync(join(appData(), 'provider-chats', 'codex')).sort()).toEqual(before);
  });

  it('refuses the active Claude by name', async () => {
    await boot('claude');
    const res = await app.inject({ method: 'GET', url: '/api/provider-chat/chats' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ messageCode: 'foreign-chat-not-for-claude' });
  });
});
