import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramNotifier } from '../telegram.ts';
import { TelegramAnswersService, type AnswersServiceDeps } from './service.ts';
import { SentLog } from './sent-log.ts';
import { AnswersStore } from './store.ts';
import type { BotUpdate, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Сворачивание отвеченного и /clear (владелец 25.10.2026, правка 13б).
 *
 * Отвеченное не удаляется: когда отвечены ВСЕ ожидания сообщения, оно сразу
 * правится в строки итога без кнопок. Удаляет бот только по /clear. Telegram
 * удаляет лишь сообщения моложе 48 часов: старше — пропускается молча; отказ
 * удаления — в журнал и забыть, без повтора. Очередь удалений прежнего
 * «Убирать отвеченное» при чтении файла отбрасывается.
 *
 * /clear — владельцу: всё, что бот знает (свои сообщения и команды владельца)
 * моложе 48 часов, кроме ждущих ответа; ответ «🧹 Убрал N…» сам исчезает через 30 с.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';
const MIN = 60_000;
const HOUR = 60 * MIN;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function fakeBot(options: { deleteFails?: number } = {}) {
  const calls: Call[] = [];
  let nextMessageId = 100;
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    switch (method) {
      case 'getMe':
        return ok({ id: 123456789, username: 'deck_bot' });
      case 'getWebhookInfo':
        return ok({ url: '' });
      case 'getUpdates':
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      case 'sendMessage':
        nextMessageId += 1;
        return ok({ message_id: nextMessageId, chat: { id: Number(body.chat_id) } });
      case 'deleteMessage':
      case 'deleteMessages':
        if (options.deleteFails) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: options.deleteFails,
              description: 'Bad Request: message to delete not found',
            }),
            { status: options.deleteFails },
          );
        }
        return ok(true);
      default:
        return ok(true);
    }
  });
  return { calls, fetchStub };
}

const item = (key: string): PendingAskItem => ({
  key,
  target: { kind: 'permission', runKey: 'run-1', toolUseId: key },
  openId: 'sess-1',
  source: { project: 'shop', chatTitle: 'Вход', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: '2026-10-25T10:00:00.000Z',
  immediate: true,
  toolName: 'Bash',
  summary: 'git push',
});

describe('сворачивание отвеченного и /clear', () => {
  let service: TelegramAnswersService | undefined;
  let dir: string | undefined;
  afterEach(() => {
    service?.stop();
    service = undefined;
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  let now = Date.parse('2026-10-25T10:10:00.000Z');

  async function make(
    over: Partial<AnswersServiceDeps> & {
      items?: PendingAskItem[];
      store?: AnswersStore;
      bot?: ReturnType<typeof fakeBot>;
    } = {},
  ) {
    const bot = over.bot ?? fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const store = over.store ?? new AnswersStore();
    store.setSettings({
      enabled: true,
      afterMinutes: 0,
      ownerId: OWNER,
      ownerName: '',
    });
    const items = over.items ?? [item('p1')];
    const sentLog = over.sentLog ?? new SentLog();
    service = new TelegramAnswersService({
      store,
      // Тишина после старта (B7) проверяется отдельно, в telegram-batch.test.ts.
      sendGraceMs: 0,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => items,
      apply: async () => ({ ok: true }),
      vanished: () => ({ kind: 'inPanel' }),
      log: () => undefined,
      now: () => now,
      scanMs: 3_600_000,
      coalesceMs: 0,
      sentLog,
      ...over,
    });
    await service.restart();
    return { bot, store, items, sentLog, service };
  }

  const press = (data: string, messageId: number): BotUpdate => ({
    update_id: 1,
    callback_query: {
      id: 'cb',
      from: { id: Number(OWNER) },
      data,
      message: { message_id: messageId, chat: { id: Number(OWNER) } },
    },
  });
  const deletes = (bot: ReturnType<typeof fakeBot>) =>
    bot.calls.filter((call) => call.method === 'deleteMessage' || call.method === 'deleteMessages');
  const keyboard = (bot: ReturnType<typeof fakeBot>) =>
    (
      bot.calls.find((call) => call.method === 'sendMessage')!.body.reply_markup as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();

  it('отвеченное сразу сворачивается в строку итога и не удаляется — ни через 10 минут, ни через сутки', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, store, items, service: svc } = await make();
    await svc.scan();
    const messageId = store.messages()[0]!.messageId;
    await svc.handleUpdate(press(keyboard(bot)[0]!.callback_data, messageId));
    const edit = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit.body.text)).toMatch(/^✅ Разрешено \d\d:\d\d · git push · 📁 shop · Вход$/);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    items.length = 0;
    for (const step of [11 * MIN, 24 * HOUR]) {
      now += step;
      await svc.scan();
    }
    expect(deletes(bot)).toHaveLength(0);
  });

  it('сводное сообщение сворачивается, только когда отвечены все', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, store, service: svc } = await make({ items: [item('p1'), item('p2')] });
    await svc.scan();
    const messageId = store.messages()[0]!.messageId;
    const allow = keyboard(bot).filter((button) => button.text.includes('Разрешить'));
    await svc.handleUpdate(press(allow[0]!.callback_data, messageId));
    const first = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(first.body.text)).toContain('<b>Ждут ответа: 2</b>');
    expect(
      (first.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard.length,
    ).toBeGreaterThan(0);
    await svc.handleUpdate(press(allow[1]!.callback_data, messageId));
    const last = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(last.body.text).split('\n')).toHaveLength(2);
    expect(String(last.body.text)).not.toContain('<b>');
    expect(last.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(deletes(bot)).toHaveLength(0);
  });

  it('уведомления («Готово» и др.) бот сам не удаляет — только запоминает для /clear', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const sentLog = new SentLog();
    createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: OWNER, events: ['runError'] }),
      token: () => TOKEN,
      onSent: (chatId, messageId) => sentLog.record({ chatId, messageId, at: now, kind: 'bot' }),
    })({ kind: 'error', chatId: 'run-1', errorText: 'TypeError' });
    await vi.waitFor(() => expect(sentLog.list(now)).toHaveLength(1));
    const { service: svc } = await make({ items: [], sentLog, bot });
    now += 2 * HOUR;
    await svc.scan();
    expect(deletes(bot)).toHaveLength(0);
  });

  it('старше 48 часов — молча пропущено и забыто; отказ 400/403 — в журнал, без повтора', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const store = new AnswersStore();
    store.scheduleDelete({
      chatId: OWNER,
      messageId: 7,
      at: now,
      sentAt: now - 49 * HOUR,
      force: true,
    });
    const { bot, service: svc } = await make({ items: [], store });
    await svc.scan();
    expect(deletes(bot)).toHaveLength(0);
    expect(store.pendingDeletes()).toEqual([]);

    service?.stop();
    const logs: string[] = [];
    const failing = fakeBot({ deleteFails: 400 });
    const store2 = new AnswersStore();
    store2.scheduleDelete({
      chatId: OWNER,
      messageId: 8,
      at: now,
      sentAt: now - HOUR,
      force: true,
    });
    const second = await make({
      items: [],
      store: store2,
      bot: failing,
      log: (line) => logs.push(line),
    });
    await second.service.scan();
    await second.service.scan();
    expect(deletes(failing)).toHaveLength(1);
    expect(store2.pendingDeletes()).toEqual([]);
    expect(logs.join('\n')).toMatch(/delete failed \(400\)/);

    service?.stop();
    const forbidden = fakeBot({ deleteFails: 403 });
    const store3 = new AnswersStore();
    store3.scheduleDelete({
      chatId: OWNER,
      messageId: 9,
      at: now,
      sentAt: now - HOUR,
      force: true,
    });
    const third = await make({ items: [], store: store3, bot: forbidden });
    await third.service.scan();
    await third.service.scan();
    expect(deletes(forbidden)).toHaveLength(1);
  });

  it('удаление ответа /clear переживает перезапуск; очередь прежнего «Убирать отвеченное» отброшена', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    dir = mkdtempSync(join(tmpdir(), 'cc-tg-cleanup-'));
    const before = new AnswersStore(dir);
    before.scheduleDelete({ chatId: OWNER, messageId: 10, at: now + 5 * MIN, sentAt: now });
    before.scheduleDelete({
      chatId: OWNER,
      messageId: 11,
      at: now + 5 * MIN,
      sentAt: now,
      force: true,
    });
    const after = new AnswersStore(dir);
    expect(after.pendingDeletes()).toEqual([
      { chatId: OWNER, messageId: 11, at: now + 5 * MIN, sentAt: now, force: true },
    ]);
    const { bot, service: svc } = await make({ items: [], store: after });
    now += 6 * MIN;
    await svc.scan();
    expect(deletes(bot)).toEqual([
      { method: 'deleteMessage', body: { chat_id: OWNER, message_id: 11 } },
    ]);
  });

  it('/clear: удаляет известное моложе 48 часов пачкой, ждущее оставляет, ответ уходит через 30 с', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const sentLog = new SentLog();
    sentLog.record({ chatId: OWNER, messageId: 1, at: now - HOUR, kind: 'bot' });
    sentLog.record({ chatId: OWNER, messageId: 2, at: now - 2 * HOUR, kind: 'bot' });
    sentLog.record({ chatId: OWNER, messageId: 3, at: now - 50 * HOUR, kind: 'bot' });
    const { bot, store, service: svc } = await make({ sentLog });
    await svc.scan();
    const pendingId = store.messages()[0]!.messageId;
    await svc.handleUpdate({
      update_id: 2,
      message: {
        message_id: 50,
        text: '/clear',
        chat: { id: Number(OWNER), type: 'private' },
        from: { id: Number(OWNER) },
      },
    });
    const batch = bot.calls.find((call) => call.method === 'deleteMessages')!;
    expect(batch.body.chat_id).toBe(OWNER);
    expect([...(batch.body.message_ids as number[])].sort((a, b) => a - b)).toEqual([1, 2, 50]);
    expect(batch.body.message_ids).not.toContain(pendingId);
    const reply = bot.calls.filter((call) => call.method === 'sendMessage').pop()!;
    expect(String(reply.body.text)).toBe(
      '🧹 Убрал 3 сообщений. Старше 48 часов Telegram удалять не даёт — для полной очистки: ' +
        'меню чата → Очистить историю.\nОсталось ждущих: 1.',
    );
    const replyId = 100 + bot.calls.filter((call) => call.method === 'sendMessage').length;
    now += 31_000;
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'deleteMessage').at(-1)?.body).toEqual({
      chat_id: OWNER,
      message_id: replyId,
    });
  });

  it('/clear не от владельца — тишина; /clear в меню команд и в /help', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, service: svc } = await make({ items: [] });
    await svc.handleUpdate({
      update_id: 3,
      message: { message_id: 60, text: '/clear', chat: { id: 999 }, from: { id: 999 } },
    });
    expect(deletes(bot)).toHaveLength(0);
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
    await vi.waitFor(() =>
      expect(
        bot.calls
          .filter((call) => call.method === 'setMyCommands')
          .every((call) =>
            (call.body.commands as { command: string }[]).some(
              (entry) => entry.command === 'clear',
            ),
          ),
      ).toBe(true),
    );
    await svc.handleUpdate({
      update_id: 4,
      message: {
        message_id: 61,
        text: '/help',
        chat: { id: Number(OWNER) },
        from: { id: Number(OWNER) },
      },
    });
    expect(
      String(bot.calls.filter((call) => call.method === 'sendMessage').pop()!.body.text),
    ).toContain('/clear');
  });
});
