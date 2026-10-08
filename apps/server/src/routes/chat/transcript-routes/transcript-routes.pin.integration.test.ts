import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';

/**
 * Закрепление разговора в списке (владелец, 07.10.2026). Маршрут настоящий,
 * транскрипты — файлы на диске, хранилище — настоящее, с записью в state.json:
 * закрепление обязано пережить перезапуск панели, иначе оно не закрепление.
 */
describe('PUT /api/chats/:chatId/pin', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-pin-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      store,
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx);
    await app.ready();
    for (const id of ['parent', 'child', 'other']) transcript(id);
    store.setChatLink('child', {
      parentChatId: 'parent',
      groupIndex: 0,
      createdAt: '2026-10-07T10:00:00.000Z',
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'work'),
      timestamp: '2026-10-07T10:00:00.000Z',
      message: { role: 'user', content: `Задача ${chatId}` },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  const pin = (chatId: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/chats/${chatId}/pin`, payload: payload as object });

  async function list(): Promise<Map<string, ChatSummary>> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    return new Map(response.json<ChatSummary[]>().map((chat) => [chat.id, chat]));
  }

  it('закреплённый корень несёт pinnedAt в списке и в state.json; открепление снимает', async () => {
    const pinned = await pin('parent', { pinned: true });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toEqual({ id: 'parent', pinned: true });

    const chats = await list();
    expect(chats.get('parent')?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(chats.get('other')?.pinnedAt).toBeUndefined();
    expect(chats.get('child')?.pinnedAt).toBeUndefined();
    const state = JSON.parse(readFileSync(join(root, 'agentdeck', 'state.json'), 'utf8'));
    expect(Object.keys(state.chatPins)).toEqual(['parent']);
    // Новое хранилище над тем же каталогом — как панель после перезапуска.
    expect(Object.keys(new AppStore(join(root, 'agentdeck')).getChatPins())).toEqual(['parent']);

    expect((await pin('parent', { pinned: false })).statusCode).toBe(200);
    expect((await list()).get('parent')?.pinnedAt).toBeUndefined();
  });

  it('чат группы не закрепляется отдельно от родителя — 409 с кодом', async () => {
    const refused = await pin('child', { pinned: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'chat_pin_child', messageCode: 'chat-pin-child' });
    expect(store.getChatPins()).toEqual({});
  });

  it('без булева pinned — 400 с кодом, ничего не записано', async () => {
    for (const payload of [{}, { pinned: 'yes' }, { pinned: 1 }]) {
      const refused = await pin('parent', payload);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ messageCode: 'chat-pin-invalid' });
    }
    expect(store.getChatPins()).toEqual({});
  });
});
