import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushDevice } from '@agentdeck/contracts';
import type { RelayNotice } from '@agentdeck/contracts/core/relay';
import { createCoreAskDelivery } from './core-ask-delivery.ts';
import { coreTaskLink } from './core-notice.ts';
import type { CorePushMessage } from './core-notice.ts';
import { TelegramAnswersService } from './telegram-answers/service.ts';
import { SentLog } from './telegram-answers/sent-log.ts';
import { AnswersStore } from './telegram-answers/store.ts';

/**
 * Вопрос ядра в каналы (этап 10, зона D): push и Telegram сообщают и дают ссылку, ответить из
 * Telegram нельзя — reply на сообщение о вопросе ядра получает отказ, где названы панель и
 * телефон, и до ядра ничего не идёт (суд `human-strict`).
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = 4242;
const TASK = '019a0000-0000-7000-8000-000000000001';
const ASK = '019a0000-0000-7000-8000-0000000000a1';

function fakeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 300;
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getMe') return ok({ id: 123456789, username: 'deck_bot' });
    if (method === 'getWebhookInfo') return ok({ url: '' });
    if (method === 'getUpdates') {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (method === 'sendMessage') {
      nextMessageId += 1;
      return ok({ message_id: nextMessageId, chat: { id: OWNER } });
    }
    return ok(true);
  });
  return { calls, fetchStub };
}

const notice = (): RelayNotice => ({
  taskId: TASK,
  askId: ASK,
  kind: 'ask',
  title: 'Починить вход',
  deepLink: coreTaskLink(TASK, ASK, '8888'),
});

const device: PushDevice = {
  token: 'ExponentPushToken[qa]',
  platform: 'android',
  label: 'phone',
  registeredAt: '2026-11-01T00:00:00Z',
};

let service: TelegramAnswersService | undefined;
afterEach(() => {
  service?.stop();
  service = undefined;
  vi.unstubAllGlobals();
});

function delivery(over: { events?: string[]; pushEnabled?: boolean; cover?: boolean } = {}) {
  const sentLog = new SentLog();
  const pushed: CorePushMessage[][] = [];
  const channels = createCoreAskDelivery({
    telegram: () => ({
      enabled: true,
      chatId: String(OWNER),
      events: (over.events ?? ['question']) as never,
    }),
    token: () => TOKEN,
    answersCover: () => over.cover ?? false,
    sentLog,
    pushEnabled: () => over.pushEnabled ?? true,
    devices: () => [device],
    machineId: () => 'machine-0001',
    push: async (messages) => void pushed.push(messages),
    log: () => undefined,
  });
  return { deliver: channels.deliver, ready: channels.ready, sentLog, pushed };
}

describe('core ask → push and Telegram, never an answer', () => {
  it('one Telegram message with the task link (no buttons) recorded as a core ask; push opens the same task', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const { deliver, sentLog, pushed } = delivery();
    expect(await deliver(notice(), 'Делить задачу на две?')).toBe(true);

    const sends = bot.calls.filter((call) => call.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    const text = String(sends[0]!.body.text);
    expect(text).toContain('Починить вход');
    expect(text).toContain('Делить задачу на две?');
    expect(text).toContain('в панели или с телефона');
    expect(text).toContain(`/core?id=${TASK}&amp;ask=${ASK}`);
    expect(sends[0]!.body.reply_markup).toBeUndefined();
    expect(sentLog.find(String(OWNER), 301, Date.now())?.coreAsk).toEqual({
      taskId: TASK,
      askId: ASK,
      deepLink: `http://127.0.0.1:8888/core?id=${TASK}&ask=${ASK}`,
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]![0]).toMatchObject({
      to: device.token,
      body: 'Починить вход',
      data: { kind: 'core-ask', taskId: TASK, askId: ASK, machineId: 'machine-0001' },
    });
  });

  it('Telegram without the «question» event (and answers off) and push switched off → silence, not delivered, not ready', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const { deliver, ready, pushed } = delivery({ events: ['runError'], pushEnabled: false });
    expect(ready()).toBe(false);
    expect(await deliver(notice(), 'q')).toBe(false);
    expect(bot.calls).toEqual([]);
    expect(pushed).toEqual([]);
    // Ответы из Telegram включены — вопрос туда идёт и без события.
    const covered = delivery({ events: ['runError'], cover: true });
    expect(covered.ready()).toBe(true);
    expect(await covered.deliver(notice(), 'q')).toBe(true);
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
  });

  it('Telegram refuses and push is off → not delivered (the relay keeps the ask pending)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' })),
      ),
    );
    const { deliver, ready } = delivery({ pushEnabled: false });
    expect(ready()).toBe(true);
    expect(await deliver(notice(), 'q')).toBe(false);
  });

  it('reply to the core-ask message → refusal naming panel and phone with the link; nothing reaches the core or a chat', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const { deliver, sentLog } = delivery();
    await deliver(notice(), 'Делить?');
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: String(OWNER) });
    const apply = vi.fn(async () => ({ ok: true as const }));
    const sendToChat = vi.fn(async () => ({ ok: true as const }));
    service = new TelegramAnswersService({
      store,
      sendGraceMs: 0,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => [],
      apply,
      sendToChat,
      vanished: () => ({ kind: 'inPanel' }),
      log: () => undefined,
      scanMs: 3_600_000,
      sentLog,
    });
    await service.restart();
    const before = bot.calls.length;
    await service.handleUpdate({
      update_id: 1,
      message: {
        message_id: 9001,
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER },
        text: 'approve-split',
        reply_to_message: { message_id: 301, chat: { id: OWNER } },
      },
    } as never);
    const replies = bot.calls.slice(before).filter((call) => call.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    const text = String(replies[0]!.body.text);
    expect(text).toContain('ядру не передан');
    expect(text).toContain('в панели');
    expect(text).toContain('с телефона');
    expect(text).toContain(`/core?id=${TASK}&amp;ask=${ASK}`);
    expect(apply).not.toHaveBeenCalled();
    expect(sendToChat).not.toHaveBeenCalled();
  });
});
