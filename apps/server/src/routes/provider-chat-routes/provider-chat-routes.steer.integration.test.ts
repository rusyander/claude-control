import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProviderChatDetail,
  ProviderChatEvent,
  ProviderChatQueued,
  ProviderChatStatus,
  ProviderChatSummary,
} from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ProviderChatService } from '../../domains/provider-chat/provider-chat.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
} from '../../domains/provider-chat/provider-chat.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { registerProviderChatRoutes } from './provider-chat-routes.ts';

/**
 * Сообщение посреди ответа чужого CLI (В1) через настоящие маршруты и сервис:
 * `queueIfBusy` сначала пробует идущий ход, и только отказ ставит в очередь.
 * Подменён только прогон — ход, который принимает или не принимает сообщение.
 */

interface Run {
  emit: (event: ProviderChatRunEvent) => void;
  steers: string[];
}
const runs: Run[] = [];
let accept = true;

class SteerableRun implements ProviderChatRunLike {
  private readonly record: Run = { emit: () => {}, steers: [] };

  start(_options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.record.emit = onEvent;
    runs.push(this.record);
    return new Promise<void>(() => {});
  }

  async steer(text: string): Promise<boolean> {
    if (!accept) return false;
    this.record.steers.push(text);
    return true;
  }

  stop(): void {}
}

describe('чужой CLI: сообщение посреди ответа через маршруты', () => {
  let root: string;
  let app: FastifyInstance;
  let chats: ProviderChatService;

  beforeEach(async () => {
    runs.length = 0;
    accept = true;
    root = mkdtempSync(join(tmpdir(), 'cc-psteer-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    const store = new AppStore(appData);
    store.updateSettings({ provider: 'codex' });
    chats = new ProviderChatService(() => new SteerableRun() as unknown as ProviderChatRunLike);
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
    await app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${chat.id}/send`,
      payload: { text: 'первый' },
    });
    return chat.id;
  }

  const status = async (id: string): Promise<ProviderChatStatus> =>
    (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}/status` })
    ).json<ProviderChatStatus>();
  const send = (id: string, text: string) =>
    app.inject({
      method: 'POST',
      url: `/api/provider-chat/chats/${id}/send`,
      payload: { text, queueIfBusy: true },
    });
  const messages = async (id: string) =>
    (
      await app.inject({ method: 'GET', url: `/api/provider-chat/chats/${id}` })
    ).json<ProviderChatDetail>().messages;

  it('статус говорит «принимает посреди ответа» только с начала хода и до его конца', async () => {
    const id = await busyChat();
    expect((await status(id)).steerable).toBeUndefined();
    runs[0]!.emit({ type: 'steerable' });
    expect((await status(id)).steerable).toBe(true);
    runs[0]!.emit({ type: 'done', reply: 'ответ', transport: 'live' });
    expect((await status(id)).steerable).toBeUndefined();
  });

  it('ход принял — 200 steered, реплика в переписке с пометкой, очереди нет, вкладки узнают', async () => {
    const id = await busyChat();
    const heard: ProviderChatEvent[] = [];
    chats.subscribe(id, { send: (event) => void heard.push(event), close: () => {} });
    runs[0]!.emit({ type: 'steerable' });

    const sent = await send(id, 'ещё учти X');
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ steered: true, message: { content: 'ещё учти X' } });
    expect(runs[0]!.steers).toEqual(['ещё учти X']);
    expect((await status(id)).queued).toBeUndefined();
    expect(heard.map((event) => event.type)).toEqual(['steerable', 'steered']);

    runs[0]!.emit({ type: 'done', reply: 'ответ с X', transport: 'live' });
    expect(runs).toHaveLength(1);
    const feed = await messages(id);
    expect(feed.map((item) => [item.content, item.steered ?? false])).toEqual([
      ['первый', false],
      ['ещё учти X', true],
      ['ответ с X', false],
    ]);
  });

  it('ход не принял — 202 и очередь, как до В1; конец ответа её отпускает', async () => {
    const id = await busyChat();
    accept = false;
    const sent = await send(id, 'подождёт');
    expect(sent.statusCode).toBe(202);
    const { queued } = sent.json<{ queued: ProviderChatQueued }>();
    expect((await status(id)).queued).toEqual([queued]);

    runs[0]!.emit({ type: 'done', reply: 'ответ', transport: 'stream' });
    expect(runs).toHaveLength(2);
    expect((await messages(id)).some((item) => item.steered)).toBe(false);
  });
});
