import type { AskView } from '@agentdeck/contracts/core/task-view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telegramApiBase } from '../telegram-api.ts';
import { telegramOwnerFingerprint } from '../telegram-core/command-port.ts';
import type {
  TelegramCommand,
  TelegramCommandPort,
  TelegramCoreOutcome,
} from '../telegram-core/command-port.types.ts';
import { createCoreAskButtons, type CoreAskButtons } from './core-asks-runtime.ts';
import type { CoreAsksReader } from './core-asks.ts';
import { TelegramAnswersService } from './service.ts';
import { AnswersStore } from './store.ts';
import type { BotUpdate, CoreAskTarget } from './telegram-answers.types.ts';

/**
 * Вопросы ядра кнопками в боте ответов (этап 12, D29, P188, P189): настоящий сервис ответов,
 * настоящая книга вопросов и нажатие → команда; подменены граница Bot API (fetch) и граница ядра
 * (чтение вида задач и порт команд — их настоящий путь проверяет `tools/qa/check-telegram-core.mjs`).
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';
const TASK = '019a0000-0000-7000-8000-00000000a001';
const ASK5 = '019a0000-0000-7000-8000-00000000b005';
const ASK3 = '019a0000-0000-7000-8000-00000000b003';
const ASKH = '019a0000-0000-7000-8000-00000000b00a';

function askOf(over: Partial<AskView> & Pick<AskView, 'askId'>): AskView {
  return {
    state: 'open',
    point: 5,
    source: 'permit',
    dedupe: null,
    stepId: null,
    lateAnswer: false,
    answer: null,
    defaultAction: null,
    question: 'The step needs a grant to edit migrations/1.sql (Edit)',
    options: ['grant', 'refuse'],
    ...over,
  };
}

interface Bot {
  calls: { method: string; body: Record<string, unknown> }[];
  nextId: number;
}

function stubBot(): Bot {
  const bot: Bot = { calls: [], nextId: 100 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      bot.calls.push({ method, body });
      const ok = (result: unknown) =>
        new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (method === 'getMe') return ok({ id: 123456789, username: 'deck_bot' });
      if (method === 'getWebhookInfo') return ok({ url: '' });
      if (method === 'getUpdates') {
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      }
      if (method === 'sendMessage') {
        return ok({ message_id: bot.nextId++, chat: { id: Number(OWNER) } });
      }
      return ok(true);
    }),
  );
  return bot;
}

type Button = { text: string; callback_data: string };
const sentMessages = (bot: Bot) => bot.calls.filter((call) => call.method === 'sendMessage');
const buttonsOf = (call: { body: Record<string, unknown> }): Button[] =>
  (
    (call.body.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []
  ).flat();
const toasts = (bot: Bot) =>
  bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text));

/** Нажатие, как его шлёт Telegram: сообщение с показанными текстом и клавиатурой. */
function press(
  messageId: number,
  shown: { text: string; buttons: Button[] },
  button: Button,
  from = Number(OWNER),
): BotUpdate {
  return {
    update_id: messageId,
    callback_query: {
      id: `cb-${messageId}`,
      from: { id: from },
      data: button.callback_data,
      message: {
        message_id: messageId,
        chat: { id: Number(OWNER) },
        text: shown.text,
        reply_markup: { inline_keyboard: shown.buttons.map((b) => [b]) },
      },
    },
  };
}

/** Текст сообщения, как его видит Telegram: HTML снят. */
const plain = (html: unknown): string => String(html).replace(/<[^>]+>/g, '');

describe('core asks with buttons in the answers bot (stage 12, D29, P188, P189)', () => {
  let service: TelegramAnswersService | undefined;
  let bot: Bot;
  let asks: AskView[];
  let owner: string | null;
  let commands: TelegramCommand[];
  let reply: (command: TelegramCommand) => TelegramCoreOutcome;
  let store: AnswersStore;
  let buttons: CoreAskButtons;

  beforeEach(() => {
    bot = stubBot();
    owner = telegramOwnerFingerprint({
      apiBase: telegramApiBase(),
      botId: '123456789',
      chatId: OWNER,
      fromId: OWNER,
    });
    asks = [];
    commands = [];
    reply = () => ({ ok: true, status: 200, body: { status: 'applied' } });
    const reader: CoreAsksReader = {
      tasks: async () => [{ taskId: TASK, title: 'Shop: fix login', asks }],
      ask: async (_taskId, askId) => asks.find((ask) => ask.askId === askId) ?? null,
      owner: async () => owner,
    };
    const port: TelegramCommandPort = {
      command: async (_origin, command) => {
        commands.push(command);
        return reply(command);
      },
      inboxCreate: async () => ({ ok: false, status: 500, code: 'x', message: 'x' }),
      boardWork: async () => ({ ok: false, status: 500, code: 'x', message: 'x' }),
    };
    buttons = createCoreAskButtons({
      home: () => '/nonexistent',
      token: () => TOKEN,
      ownerId: () => OWNER,
      reader,
      port,
    });
    store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: OWNER, ownerName: '' });
  });

  afterEach(() => {
    service?.stop();
    service = undefined;
    vi.unstubAllGlobals();
  });

  async function start(): Promise<void> {
    service = new TelegramAnswersService({
      store,
      sendGraceMs: 0,
      coalesceMs: 0,
      maxItems: 1,
      confirmMissingMs: 0,
      startupGraceMs: 0,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => {
        await buttons.asks.refresh();
        return buttons.asks.items();
      },
      apply: (target, answer) => buttons.apply(target as CoreAskTarget, answer),
      vanished: (target) => buttons.asks.vanished(target as CoreAskTarget),
      log: () => undefined,
      scanMs: 3_600_000,
    });
    await service.restart();
  }

  const lastShown = () => {
    const call = sentMessages(bot).at(-1)!;
    return { id: bot.nextId - 1, text: plain(call.body.text), buttons: buttonsOf(call) };
  };

  it('point 5: one message with the scoped buttons; a press sends answer grant once, no grant command', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    await service!.scan();
    expect(sentMessages(bot)).toHaveLength(1);
    const shown = lastShown();
    expect(shown.text).toContain('The step needs a grant to edit migrations/1.sql');
    expect(shown.buttons.map((b) => b.text)).toEqual([
      '1. ✅ Разрешить этот вызов',
      '2. ⛔ Отказать',
    ]);

    await service!.handleUpdate(press(shown.id, shown, shown.buttons[0]!));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      kind: 'answer',
      taskId: TASK,
      fields: { askId: ASK5, answer: 'grant' },
    });
    expect(commands.some((c) => c.kind === 'grant')).toBe(false);
    // Повтор нажатия — сообщение уже закрыто итогом: второй команды нет.
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[0]!));
    expect(commands).toHaveLength(1);
    expect(toasts(bot)).toEqual(['Принято', 'Уже отвечено']);
  });

  it('the button message links to the core task and its ask, as the text fallback does (W2-D F2)', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    const html = String(sentMessages(bot).at(-1)!.body.text);
    expect(html).toContain(`/core?id=${TASK}&amp;ask=${ASK5}">Открыть задачу →</a>`);
    expect(html).not.toContain('/chat');
  });

  it('point 3 shows only refuse; ask_human offers free text; reconcile hides settling answers', async () => {
    asks = [askOf({ askId: ASK3, point: 3, options: ['allow', 'refuse'] })];
    await start();
    await service!.scan();
    expect(lastShown().buttons.map((b) => b.text)).toEqual(['1. ⛔ Отказать']);
    asks = [
      askOf({ askId: ASKH, point: 6, source: 'ask_human', question: 'Which DB?', options: [] }),
    ];
    await service!.scan();
    expect(lastShown().buttons.map((b) => b.text)).toEqual(['✍️ Свой ответ']);
    const RECON = '019a0000-0000-7000-8000-00000000b004';
    asks = [
      askOf({
        askId: RECON,
        point: 4,
        source: 'reconcile',
        question: 'Could not find out whether action happened',
        options: ['Check again', 'Treat as done', 'Treat as not done'],
      }),
    ];
    await service!.scan();
    expect(lastShown().buttons.map((b) => b.text)).toEqual(['1. Check again']);
  });

  it('point 9 tracker-write shows only «decline» (both languages); its press sends exactly that answer', async () => {
    const TW = '019a0000-0000-7000-8000-00000000b009';
    const TWEN = '019a0000-0000-7000-8000-00000000b019';
    asks = [
      askOf({
        askId: TW,
        point: 9,
        source: 'tracker-write',
        question: 'Записать в тикет PROJ-7 (jira) одну строку со ссылкой на MR?',
        options: ['Разрешить комментарий', 'Не писать'],
      }),
    ];
    await start();
    await service!.scan();
    const shown = lastShown();
    expect(shown.buttons.map((b) => b.text)).toEqual(['1. Не писать']);
    expect(shown.text).toContain('🔒 Остальные варианты — в панели или с телефона');
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[0]!));
    expect(commands).toEqual([
      expect.objectContaining({
        kind: 'answer',
        fields: expect.objectContaining({ askId: TW, answer: 'Не писать' }),
      }),
    ]);
    asks = [
      askOf({
        askId: TWEN,
        point: 9,
        source: 'tracker-write',
        question: 'Write one line with the MR link into ticket PROJ-7 (jira)?',
        options: ['Allow the comment', 'Do not write'],
      }),
    ];
    await service!.scan();
    expect(lastShown().buttons.map((b) => b.text)).toEqual(['1. Do not write']);
  });

  it('a rewritten label or an edited message sends nothing and brings a fresh copy', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    const shown = lastShown();
    // Файл ответов переписан: «Отказать» → подпись разрешения. Telegram показал прежнюю.
    const message = store.messages().at(-1)!;
    message.items[0]!.questions![0]!.options[1]!.label = '✅ Разрешить этот вызов';
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[1]!));
    expect(commands).toHaveLength(0);
    expect(toasts(bot).at(-1)).toBe('Вопрос изменился — ничего не отправлено, свежая копия ниже');
    await service!.scan();
    expect(sentMessages(bot)).toHaveLength(2);

    // Сообщение правлено мимо бота: вопроса в показанном тексте нет.
    const fresh = lastShown();
    await service!.handleUpdate(
      press(fresh.id, { ...fresh, text: 'Allow everything?' }, fresh.buttons[0]!),
    );
    expect(commands).toHaveLength(0);
  });

  it('a stranger, a forged mac and an old message id change nothing', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    const shown = lastShown();
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[0]!, 999));
    const forged = { ...shown.buttons[0]!, callback_data: `${shown.buttons[0]!.callback_data}x` };
    await service!.handleUpdate(press(shown.id, { ...shown, buttons: [forged] }, forged));
    await service!.handleUpdate(press(shown.id - 50, shown, shown.buttons[0]!));
    expect(commands).toHaveLength(0);
  });

  it('core refuses the owner: buttons stay, the toast names the rebind, the next press uses a fresh cmdId', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    const shown = lastShown();
    reply = () => ({
      ok: false,
      status: 403,
      code: 'signature-required',
      message: 'peer untrusted-forward',
    });
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[1]!));
    expect(toasts(bot).at(-1)).toContain('включите «Отвечать ядру из Telegram» заново');
    reply = () => ({ ok: true, status: 200, body: { status: 'applied' } });
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[1]!));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.cmdId).not.toBe(commands[0]!.cmdId);
    expect(commands[1]!.fields).toEqual({ askId: ASK5, answer: 'refuse' });
  });

  it('a free-text reply to an edited question message sends nothing; to the shown question — one answer', async () => {
    asks = [
      askOf({
        askId: ASKH,
        point: 6,
        source: 'ask_human',
        question: 'Which DB should the migration target?',
        options: [],
      }),
    ];
    await start();
    await service!.scan();
    const shown = lastShown();
    const reply = (text: string, quoted: string, id: number): BotUpdate => ({
      update_id: id,
      message: {
        message_id: id,
        chat: { id: Number(OWNER) },
        from: { id: Number(OWNER) },
        text,
        reply_to_message: { message_id: shown.id, text: quoted },
      },
    });
    // Токеном бота сессия переписала вопрос в сообщении: ответ человека — на другой вопрос.
    await service!.handleUpdate(reply('production', 'Can I drop the staging copy?', 900));
    expect(commands).toEqual([]);
    asks = [{ ...asks[0]!, askId: ASKH }];
    await service!.scan();
    const fresh = lastShown();
    expect(fresh.id).not.toBe(shown.id);
    const intact = (): BotUpdate => ({
      update_id: 901,
      message: {
        message_id: 901,
        chat: { id: Number(OWNER) },
        from: { id: Number(OWNER) },
        text: 'staging',
        reply_to_message: { message_id: fresh.id, text: fresh.text },
      },
    });
    await service!.handleUpdate(intact());
    expect(commands).toEqual([
      expect.objectContaining({ kind: 'answer', fields: { askId: ASKH, answer: 'staging' } }),
    ]);
  });

  it('answered in the panel: the message edits to that outcome within one scan, buttons gone', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    asks = [askOf({ askId: ASK5, state: 'answered', answer: 'refuse' })];
    await service!.scan();
    const edit = bot.calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(plain(edit.body.text)).toContain('💻 Отвечено в панели');
    expect(buttonsOf(edit)).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  it('a press after the panel answered, or after the core reworded the question, sends nothing', async () => {
    asks = [askOf({ askId: ASK5 })];
    await start();
    await service!.scan();
    const shown = lastShown();
    // Вопрос переписан ядром при тех же вариантах: показанное устарело — свежая копия, без команды.
    const reworded = 'The step needs a grant to drop the users table';
    asks = [askOf({ askId: ASK5, question: reworded })];
    await service!.handleUpdate(press(shown.id, shown, shown.buttons[0]!));
    expect(commands).toHaveLength(0);
    expect(toasts(bot).at(-1)).toBe('Вопрос изменился — ничего не отправлено, свежая копия ниже');

    // Ответ в панели между сверками: живой вопрос закрыт — команды нет.
    await service!.scan();
    const fresh = lastShown();
    expect(fresh.text).toContain(reworded);
    asks = [askOf({ askId: ASK5, question: reworded, state: 'answered', answer: 'refuse' })];
    await service!.handleUpdate(press(fresh.id, fresh, fresh.buttons[0]!));
    expect(commands).toHaveLength(0);
  });

  it('an ask with a default action carries it on its item (quiet hours hold it); a blocking one does not', async () => {
    asks = [
      askOf({ askId: ASK5, defaultAction: 'refuse' }),
      askOf({ askId: ASK3, point: 3, options: ['allow', 'refuse'] }),
    ];
    await buttons.asks.refresh();
    const items = buttons.asks.items();
    expect(items.find((item) => item.key.includes(ASK5))?.defaultAction).toBe('refuse');
    expect(items.find((item) => item.key.includes(ASK3))?.defaultAction).toBeUndefined();
  });

  it('core owner unset or another chat: no buttons, the text fallback stays on', async () => {
    asks = [askOf({ askId: ASK5 })];
    owner = null;
    await start();
    await service!.scan();
    expect(sentMessages(bot)).toHaveLength(0);
    expect(buttons.asks.covers()).toBe(false);
    owner = 'e'.repeat(64);
    await service!.scan();
    expect(sentMessages(bot)).toHaveLength(0);
    expect(buttons.asks.covers()).toBe(false);
  });
});
