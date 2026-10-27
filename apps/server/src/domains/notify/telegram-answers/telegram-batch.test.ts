import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramNotifier } from '../telegram.ts';
import { TelegramAnswersService, type AnswersServiceDeps } from './service.ts';
import { SentLog } from './sent-log.ts';
import { sleep } from './sleep.ts';
import { AnswersStore } from './store.ts';
import type { BotMessage, BotUpdate, ChatRoute, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Пачка владельца 25.10.2026 после двух аудитов: устаревшее нажатие не уходит в
 * чат (A1), ответ-reply на любое сообщение бота доходит до своего чата (A4) и
 * несёт картинки (14), отвеченное сворачивается в строку итога (13б), после
 * старта и сна — две минуты тишины (B7), «внимание» сторожа в Telegram не
 * уходит (B8), мелкая надёжность (A5).
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = 4242;
const MIN = 60_000;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function fakeBot(options: { files?: Record<string, { size: number; path: string }> } = {}) {
  const calls: Call[] = [];
  const replies: Record<string, () => Response> = {};
  let nextMessageId = 100;
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/file/bot')) {
      calls.push({ method: 'download', body: { path: path.split('/').pop() } });
      return new Response(Buffer.from('PNGDATA'));
    }
    const method = path.split('/').pop()!;
    const body: Record<string, unknown> = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    const override = replies[method];
    if (override) return override();
    switch (method) {
      case 'getMe':
        return ok({ id: 123456789, username: 'deck_bot' });
      case 'getWebhookInfo':
        return ok({ url: '' });
      case 'getUpdates':
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      case 'sendMessage':
        nextMessageId += 1;
        return ok({ message_id: nextMessageId, chat: { id: OWNER } });
      case 'getFile': {
        const file = options.files?.[String(body.file_id)];
        return file
          ? ok({ file_id: body.file_id, file_size: file.size, file_path: file.path })
          : ok({
              file_id: body.file_id,
              file_size: 7,
              file_path: `photos/${String(body.file_id)}.jpg`,
            });
      }
      default:
        return ok(true);
    }
  });
  return { calls, fetchStub, replies };
}

const route: ChatRoute = { chatId: 's9', sessionId: 's9', projectPath: '/w/shop', title: 'Вход' };

const permission: PendingAskItem = {
  key: 'p1',
  target: { kind: 'permission', runKey: 'run-1', toolUseId: 'p1' },
  openId: 's1',
  source: { project: 'shop', chatTitle: 'Вход', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: '2026-10-25T10:00:00.000Z',
  immediate: true,
  toolName: 'Bash',
  description: 'Bash',
  summary: 'git push',
  chat: { chatId: 's1', sessionId: 's1', projectPath: '/w/shop', title: 'Вход' },
};

const question: PendingAskItem = {
  key: 'q1',
  target: { kind: 'question', chatId: 's1', projectPath: '/w/shop' },
  openId: 's1',
  source: { project: 'shop', chatTitle: 'Вход', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: '2026-10-25T10:00:00.000Z',
  immediate: true,
  questions: [{ question: 'Какой цвет?', options: [{ label: 'Синий' }, { label: 'Красный' }] }],
  chat: { chatId: 's1', sessionId: 's1', projectPath: '/w/shop', title: 'Вход' },
};

describe('пачка 25.10: ответы, сворачивание, тишина после старта', () => {
  let service: TelegramAnswersService | undefined;
  afterEach(() => {
    service?.stop();
    service = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  let now = Date.parse('2026-10-25T10:10:00.000Z');

  async function make(
    over: Partial<AnswersServiceDeps> & {
      items?: PendingAskItem[];
      bot?: ReturnType<typeof fakeBot>;
      enabled?: boolean;
    } = {},
  ) {
    const bot = over.bot ?? fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: String(OWNER) });
    const items = over.items ?? [permission];
    const apply = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    const sendToChat = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    const sentLog = over.sentLog ?? new SentLog();
    service = new TelegramAnswersService({
      store,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => items,
      apply,
      sendToChat,
      vanished: () => ({ kind: 'inPanel' }),
      log: () => undefined,
      now: () => now,
      scanMs: 3_600_000,
      coalesceMs: 0,
      sendGraceMs: 0,
      albumWaitMs: 20,
      sentLog,
      ...over,
    });
    await service.restart();
    return { bot, store, items, apply, sendToChat, sentLog, service };
  }

  const sends = (bot: ReturnType<typeof fakeBot>) =>
    bot.calls.filter((call) => call.method === 'sendMessage');
  const lastEdit = (bot: ReturnType<typeof fakeBot>) =>
    bot.calls.filter((call) => call.method === 'editMessageText').pop();
  const buttons = (bot: ReturnType<typeof fakeBot>) =>
    (
      sends(bot)[0]!.body.reply_markup as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();
  const press = (data: string, messageId: number): BotUpdate => ({
    update_id: 1,
    callback_query: {
      id: 'cb',
      from: { id: OWNER },
      data,
      message: { message_id: messageId, chat: { id: OWNER } },
    },
  });
  const reply = (over: Partial<BotMessage> & Record<string, unknown>): BotUpdate => ({
    update_id: 2,
    message: {
      message_id: 700,
      chat: { id: OWNER },
      from: { id: OWNER },
      ...over,
    } as BotMessage,
  });

  it('A1: нажатие на вопрос, которого уже нет, — «уже не актуально», в чат ничего не уходит', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, store, items, apply, service: svc } = await make({ items: [question] });
    await svc.scan();
    const id = store.messages()[0]!.messageId;
    items.length = 0;
    await svc.handleUpdate(press(buttons(bot)[0]!.callback_data, id));
    expect(apply).not.toHaveBeenCalled();
    expect(String(lastEdit(bot)!.body.text)).toContain('⌛ Уже не актуально');
    expect(bot.calls.find((call) => call.method === 'answerCallbackQuery')!.body.text).toBe(
      'Уже не актуально',
    );
  });

  it('13б: ответили на всё — сообщение сворачивается в строку итога без кнопок', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, store, service: svc } = await make();
    await svc.scan();
    const id = store.messages()[0]!.messageId;
    await svc.handleUpdate(press(buttons(bot)[0]!.callback_data, id));
    const edit = lastEdit(bot)!;
    expect(String(edit.body.text)).toMatch(/^✅ Разрешено \d\d:\d\d · git push · 📁 shop · Вход$/);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(bot.calls.some((call) => call.method === 'deleteMessage')).toBe(false);
  });

  it('A4: ответ-reply на уведомление — текстом в тот же чат и короткое «Отправлено»', async () => {
    const sentLog = new SentLog();
    sentLog.record({ chatId: String(OWNER), messageId: 900, at: now, kind: 'bot', route });
    const { bot, sendToChat, service: svc } = await make({ items: [], sentLog });
    await svc.handleUpdate(reply({ text: 'продолжай', reply_to_message: { message_id: 900 } }));
    expect(sendToChat).toHaveBeenCalledWith(route, 'продолжай', [], expect.any(String));
    expect(sends(bot).pop()!.body.text).toBe('✉️ Отправлено в «Вход»');
  });

  it('A4: reply на закрытый вопрос — обычным сообщением в его чат; на открытый — ответом на вопрос', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, store, apply, sendToChat, service: svc } = await make({ items: [question] });
    await svc.scan();
    const id = store.messages()[0]!.messageId;
    await svc.handleUpdate(reply({ text: 'Зелёный', reply_to_message: { message_id: id } }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toMatchObject({ kind: 'questions', picks: [['Зелёный']] });
    await svc.handleUpdate(reply({ text: 'и ещё', reply_to_message: { message_id: id } }));
    expect(sendToChat).toHaveBeenCalledWith(question.chat, 'и ещё', [], expect.any(String));
    expect(sends(bot).pop()!.body.text).toBe('✉️ Отправлено в «Вход»');
  });

  it('A4: reply на сообщение, у которого нет чата, — одна строка объяснения, не тишина', async () => {
    const { bot, sendToChat, service: svc } = await make({ items: [] });
    await svc.handleUpdate(reply({ text: 'что?', reply_to_message: { message_id: 1 } }));
    expect(sendToChat).not.toHaveBeenCalled();
    expect(String(sends(bot).pop()!.body.text)).toMatch(/^Не понял, в какой чат/);
  });

  it('14: фото с подписью в ответ на уведомление — скачано и ушло файлом вместе с текстом', async () => {
    const sentLog = new SentLog();
    sentLog.record({ chatId: String(OWNER), messageId: 900, at: now, kind: 'bot', route });
    const { bot, sendToChat, service: svc } = await make({ items: [], sentLog });
    await svc.handleUpdate(
      reply({
        caption: 'вот так',
        photo: [
          { file_id: 'small', file_size: 1 },
          { file_id: 'big', file_size: 7 },
        ],
        reply_to_message: { message_id: 900 },
      }),
    );
    await vi.waitFor(() => expect(sendToChat).toHaveBeenCalledTimes(1));
    const [, text, files] = sendToChat.mock.calls[0] as [
      ChatRoute,
      string,
      { name: string; base64: string }[],
    ];
    expect(text).toBe('вот так');
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toMatch(/^telegram-\d{8}-\d{6}-1\.jpg$/);
    expect(Buffer.from(files[0]!.base64, 'base64').toString()).toBe('PNGDATA');
    expect(bot.calls.find((call) => call.method === 'getFile')!.body.file_id).toBe('big');
    expect(sends(bot).pop()!.body.text).toBe('📎 Отправлено в «Вход»: 1 картинка + текст');
  });

  it('14: альбом из двух фото — одной отправкой, подпись со второго', async () => {
    const sentLog = new SentLog();
    sentLog.record({ chatId: String(OWNER), messageId: 900, at: now, kind: 'bot', route });
    const { sendToChat, service: svc } = await make({ items: [], sentLog });
    await svc.handleUpdate(
      reply({
        message_id: 701,
        media_group_id: 'g',
        photo: [{ file_id: 'a' }],
        reply_to_message: { message_id: 900 },
      }),
    );
    await svc.handleUpdate(
      reply({
        message_id: 702,
        media_group_id: 'g',
        photo: [{ file_id: 'b' }],
        caption: 'оба',
        reply_to_message: { message_id: 900 },
      }),
    );
    await vi.waitFor(() => expect(sendToChat).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [, text, files] = sendToChat.mock.calls[0] as [ChatRoute, string, unknown[]];
    expect(text).toBe('оба');
    expect(files).toHaveLength(2);
  });

  it('14: сессия вне панели — только текст, про картинки сказано; больше 20 МБ — не качается', async () => {
    const sentLog = new SentLog();
    sentLog.record({
      chatId: String(OWNER),
      messageId: 901,
      at: now,
      kind: 'bot',
      route: { chatId: 'vs', sessionId: 'vs', title: 'VS Code', outside: true },
    });
    sentLog.record({ chatId: String(OWNER), messageId: 900, at: now, kind: 'bot', route });
    const bot = fakeBot({ files: { huge: { size: 25 * 1024 * 1024, path: 'big.jpg' } } });
    const { sendToChat, service: svc } = await make({ items: [], sentLog, bot });
    await svc.handleUpdate(
      reply({ caption: 'текст', photo: [{ file_id: 'x' }], reply_to_message: { message_id: 901 } }),
    );
    await vi.waitFor(() => expect(sendToChat).toHaveBeenCalledTimes(1));
    expect(sendToChat.mock.calls[0]).toEqual([
      { chatId: 'vs', sessionId: 'vs', title: 'VS Code', outside: true },
      'текст',
      [],
      expect.any(String),
    ]);
    expect(String(sends(bot).pop()!.body.text)).toContain(
      'картинки сюда не передаются — только текст',
    );
    expect(bot.calls.some((call) => call.method === 'download')).toBe(false);

    await svc.handleUpdate(
      reply({
        message_id: 703,
        caption: 'большое',
        photo: [{ file_id: 'huge' }],
        reply_to_message: { message_id: 900 },
      }),
    );
    await vi.waitFor(() => expect(sendToChat).toHaveBeenCalledTimes(2));
    expect((sendToChat.mock.calls[1] as unknown[])[2]).toEqual([]);
    expect(String(sends(bot).pop()!.body.text)).toContain('больше 20 МБ');
  });

  it('B7: после старта панели — две минуты тишины, потом отправка; после сна машины — снова', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, items, service: svc } = await make({ sendGraceMs: 2 * MIN, scanMs: 5_000 });
    // Сверка каждые 30 с, как шла бы таймером: до двух минут — тишина.
    for (let step = 0; step < 4; step++) {
      await svc.scan();
      now += 30_000;
    }
    expect(sends(bot)).toHaveLength(0);
    now += 1_000;
    await svc.scan();
    expect(sends(bot)).toHaveLength(1);

    // Машина спала десять минут: новое ждёт ещё две минуты после пробуждения.
    items.push({ ...question, key: 'q2' });
    now += 10 * MIN;
    await svc.scan();
    now += 30_000;
    await svc.scan();
    expect(sends(bot)).toHaveLength(1);
    for (let step = 0; step < 4; step++) {
      now += 30_000;
      await svc.scan();
    }
    expect(sends(bot)).toHaveLength(2);
  });

  it('A5: пауза опроса снимает свой слушатель отмены, когда кончилась сама', async () => {
    const signal = new AbortController().signal;
    await sleep(1, signal);
    await sleep(1, signal);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it('B8: «внимание» сторожа в Telegram не уходит; «тревога» — словами, код правила в цитате', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const notify = createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: String(OWNER), events: ['groupSignal'] }),
      token: () => TOKEN,
      titleOf: () => 'Аудит',
    });
    notify({
      kind: 'groupSignal',
      rule: 'R2',
      severity: 'warn',
      numbers: { writeK: 40 },
      projectPath: '/w/shop',
    });
    notify({
      kind: 'groupSignal',
      rule: 'R1',
      severity: 'alert',
      numbers: { idleMin: 21 },
      projectPath: '/w/shop',
      chatId: 'g1',
      group: { index: 2, title: 'API' },
    });
    await vi.waitFor(() => expect(sends(bot)).toHaveLength(1));
    const text = String(sends(bot)[0]!.body.text);
    expect(text.split('\n').slice(0, 3)).toEqual([
      '<b>⚠️ ТРЕВОГА · 📁 shop · Аудит</b>',
      '<b>группа молчит</b>',
      '<blockquote expandable>группа 2 «API» · R1 · без событий 21 мин</blockquote>',
    ]);
  });

  it('A5: удачная отправка снимает прежнюю подробность «не удалось написать»', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const bot = fakeBot();
    bot.replies.sendMessage = () =>
      new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), {
        status: 403,
      });
    const { service: svc } = await make({ bot });
    await svc.scan();
    expect(svc.status().detail).toMatch(/не удалось написать/);
    delete bot.replies.sendMessage;
    now += 2 * MIN;
    await svc.scan();
    expect(svc.status().detail).toBeUndefined();
  });

  it('A5: /waiting — сначала новое сообщение, потом правка прежнего', async () => {
    now = Date.parse('2026-10-25T10:10:00.000Z');
    const { bot, service: svc } = await make();
    await svc.scan();
    const before = bot.calls.length;
    await svc.handleUpdate(reply({ text: '/waiting' }));
    const order = bot.calls
      .slice(before)
      .map((call) => call.method)
      .filter((method) => method === 'sendMessage' || method === 'editMessageText');
    expect(order).toEqual(['sendMessage', 'editMessageText']);
  });

  it('A5: настройку выключили мимо маршрута — опрос останавливается на ближайшем проходе', async () => {
    const { store, service: svc } = await make({ items: [] });
    expect(svc.listensTo(TOKEN)).toBe(true);
    store.setSettings({ enabled: false, afterMinutes: 0, ownerId: String(OWNER) });
    await svc.scan();
    expect(svc.listensTo(TOKEN)).toBe(false);
    expect(svc.status().state).toBe('off');
  });

  it('A5: проход без перемен файл не пишет', async () => {
    const { store, service: svc } = await make({ items: [] });
    const save = vi.spyOn(store, 'save');
    await svc.scan();
    await svc.scan();
    expect(save).not.toHaveBeenCalled();
  });

  it('A5: getMe не отвечает — повтор с растущей паузой', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bot = fakeBot();
    bot.replies.getMe = () =>
      new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
        status: 502,
      });
    await make({ bot });
    const getMes = () => bot.calls.filter((call) => call.method === 'getMe').length;
    expect(getMes()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getMes()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getMes()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getMes()).toBe(3);
  });
});
