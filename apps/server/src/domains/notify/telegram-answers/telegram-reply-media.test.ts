import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAnswersService } from './service.ts';
import { AnswersStore } from './store.ts';
import type { BotMessage, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Живой прогон владельца 25.10: «Свой ответ» ответом с двумя фото и подписью —
 * подпись молча пропала, вопрос остался открытым, и бот ничего не сказал.
 * Теперь (правка 14 того же дня): подпись — текст ответа, фото уходят с ним
 * файлами в чат панели; альбом собирается целиком и уходит одной отправкой;
 * ответ без текста и без картинок (стикер) — короткое объяснение, а не тишина.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = 4242;
const EMPTY_HINT = 'Отправлять нечего: нужен текст, картинка или PDF.';

function fakeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextMessageId = 100;
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    // Файловый сервер Telegram: картинка по адресу `file/bot<токен>/<путь>`.
    if (String(url).includes('/file/bot')) return new Response(Buffer.from('IMG'));
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
    if (method === 'getFile') {
      return ok({
        file_id: body.file_id,
        file_size: 3,
        file_path: `photos/${String(body.file_id)}.jpg`,
      });
    }
    return ok(true);
  });
  return { calls, fetchStub };
}

const question: PendingAskItem = {
  key: 'q:t@s1',
  target: { kind: 'question', chatId: 's1', projectPath: '/w/shop' },
  openId: 's1',
  source: { project: 'shop', chatTitle: 'Чат', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: '2026-10-25T10:00:00.000Z',
  immediate: true,
  questions: [{ question: 'Какой цвет?', options: [{ label: 'Синий' }] }],
};

describe('«Свой ответ» с картинками', () => {
  let service: TelegramAnswersService | undefined;
  afterEach(() => {
    service?.stop();
    vi.unstubAllGlobals();
  });

  /** Вопрос отправлен, нажато «Свой ответ» — номер сообщения-просьбы. */
  async function promptOpen() {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: String(OWNER) });
    const apply = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    service = new TelegramAnswersService({
      store,
      // Тишина после старта (B7) проверяется отдельно, в telegram-batch.test.ts.
      sendGraceMs: 0,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => [question],
      apply,
      vanished: () => ({ kind: 'inPanel' }),
      log: () => undefined,
      scanMs: 3_600_000,
      albumWaitMs: 20,
    });
    await service.restart();
    await service.scan();
    const message = store.messages()[0]!;
    const buttons = (
      bot.calls.find((call) => call.method === 'sendMessage')!.body.reply_markup as {
        inline_keyboard: { text: string; callback_data: string }[][];
      }
    ).inline_keyboard.flat();
    await service.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb',
        from: { id: OWNER },
        data: buttons.find((button) => button.text === '✍️ Свой ответ')!.callback_data,
        message: { message_id: message.messageId, chat: { id: OWNER } },
      },
    });
    const prompt = bot.calls.filter((call) => call.method === 'sendMessage').pop()!;
    const promptId = 100 + bot.calls.filter((call) => call.method === 'sendMessage').length;
    return { bot, apply, prompt, promptId, svc: service };
  }

  const reply = (promptId: number, over: Partial<BotMessage> & Record<string, unknown>) => ({
    update_id: 2,
    message: {
      message_id: 500,
      chat: { id: OWNER },
      from: { id: OWNER },
      reply_to_message: { message_id: promptId },
      ...over,
    } as BotMessage,
  });

  it('просьба короткая — без повтора вопроса', async () => {
    const { prompt } = await promptOpen();
    expect(prompt.body.text).toBe('✍️ Напишите ответ ответом на это сообщение');
  });

  it('обычный текст — ответ, как раньше', async () => {
    const { apply, promptId, svc } = await promptOpen();
    await svc.handleUpdate(reply(promptId, { text: 'Зелёный' }));
    expect(apply).toHaveBeenCalledWith(
      question.target,
      { kind: 'questions', questions: question.questions, picks: [['Зелёный']] },
      expect.any(String),
    );
  });

  it('фото с подписью — подпись и есть ответ, фото уходит с ним файлом', async () => {
    const { bot, apply, promptId, svc } = await promptOpen();
    await svc.handleUpdate(
      reply(promptId, { caption: 'Красный, как на фото', photo: [{ file_id: 'f1' }] }),
    );
    expect(apply).toHaveBeenCalledWith(
      question.target,
      {
        kind: 'questions',
        questions: question.questions,
        picks: [['Красный, как на фото']],
        files: [{ name: expect.stringMatching(/^telegram-\d{8}-\d{6}-1\.jpg$/), base64: 'SU1H' }],
      },
      expect.any(String),
    );
    expect(bot.calls.filter((call) => call.method === 'sendMessage').pop()!.body.text).toBe(
      '📎 Отправлено: 1 картинка + текст',
    );
  });

  it('альбом: подпись на втором сообщении — одна отправка, обе картинки и текст', async () => {
    const { bot, apply, promptId, svc } = await promptOpen();
    await svc.handleUpdate(
      reply(promptId, { message_id: 501, media_group_id: 'g1', photo: [{ file_id: 'a' }] }),
    );
    await svc.handleUpdate(
      reply(promptId, {
        message_id: 502,
        media_group_id: 'g1',
        photo: [{ file_id: 'b' }],
        caption: 'Оба',
      }),
    );
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toMatchObject({ picks: [['Оба']] });
    expect((apply.mock.calls[0]![1] as { files: unknown[] }).files).toHaveLength(2);
    expect(bot.calls.filter((call) => call.method === 'sendMessage').pop()!.body.text).toBe(
      '📎 Отправлено: 2 картинки + текст',
    );
  });

  it('картинки без подписи — ответом без текста; стикер — объяснение, вопрос ждёт', async () => {
    const { bot, apply, promptId, svc } = await promptOpen();
    await svc.handleUpdate(reply(promptId, { message_id: 503, sticker: { file_id: 's' } }));
    expect(apply).not.toHaveBeenCalled();
    expect(bot.calls.filter((call) => call.method === 'sendMessage').pop()!.body.text).toBe(
      `${EMPTY_HINT} · не картинка и не PDF — не передано: 1`,
    );
    await svc.handleUpdate(reply(promptId, { message_id: 504, photo: [{ file_id: 'c' }] }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toMatchObject({ picks: [[]] });
    expect((apply.mock.calls[0]![1] as { files: unknown[] }).files).toHaveLength(1);
  });
});
