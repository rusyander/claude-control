import { afterEach, describe, expect, it, vi } from 'vitest';
import { limitSharesOf, parseCommand, statusText } from './commands.ts';
import { ConnectWindow, type ConnectDeps } from './connect.ts';
import { TelegramAnswersService, type AnswersServiceDeps } from './service.ts';
import { AnswersStore } from './store.ts';
import type { BotUpdate, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Бот целиком: подключение по /start (окно, кандидат, чужие и не личные чаты,
 * истечение), команды владельца (`/status`, `/waiting`, `/help`, `/start`),
 * меню команд при старте опроса. Подделан только Bot API — `fetch`.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Bot API с очередью обновлений: `getUpdates` отдаёт накопленное или висит до новых. */
function fakeBot(options: { old?: BotUpdate[] } = {}) {
  const calls: Call[] = [];
  const queue: BotUpdate[] = [];
  let wake: (() => void) | undefined;
  let nextMessageId = 100;
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    switch (method) {
      case 'getMe':
        return ok({ id: 123456789, username: 'deck_bot' });
      case 'getWebhookInfo':
        return ok({ url: '' });
      case 'getUpdates': {
        if (body.offset === -1) return ok((options.old ?? []).slice(-1));
        if (queue.length === 0 && Number(body.timeout) > 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            init.signal?.addEventListener('abort', () => resolve());
          });
        }
        if (init.signal?.aborted) throw new Error('aborted');
        const offset = Number(body.offset ?? 0);
        return ok(queue.splice(0).filter((update) => update.update_id >= offset));
      }
      case 'sendMessage':
        nextMessageId += 1;
        return ok({ message_id: nextMessageId, chat: { id: Number(body.chat_id) } });
      default:
        return ok(true);
    }
  });
  const push = (...updates: BotUpdate[]) => {
    queue.push(...updates);
    wake?.();
  };
  return { calls, fetchStub, push };
}

const message = (
  id: number,
  over: {
    text?: string;
    from?: number;
    chat?: number;
    type?: string;
    date?: number;
    first_name?: string;
    username?: string;
  } = {},
): BotUpdate => {
  const from = over.from ?? 777;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: over.date,
      text: over.text ?? '/start',
      chat: { id: over.chat ?? from, type: over.type ?? 'private' },
      from: {
        id: from,
        first_name: over.first_name ?? 'Анна',
        ...(over.username === undefined ? { username: 'anna' } : {}),
      },
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Код окна из ссылки `t.me/<бот>?start=<код>`. */
const nonceOf = (link: string | undefined): string =>
  new URL(link ?? 'https://t.me/x').searchParams.get('start') ?? '';

describe('ConnectWindow (подключение по /start)', () => {
  let window: ConnectWindow | undefined;
  afterEach(() => {
    window?.cancel();
    window = undefined;
  });

  function make(over: Partial<ConnectDeps> = {}) {
    window = new ConnectWindow({
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      serviceListens: () => false,
      log: () => undefined,
      idleMs: 5,
      ...over,
    });
    return window;
  }

  it('окно открыто: ссылка с кодом окна, «ждём»; /start с этим кодом — кандидат с именем, ником и id', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const view = await make().open();
    expect(view).toMatchObject({ state: 'waiting', bot: 'deck_bot' });
    // Код — 96 бит случайности в base64url: 16 знаков, допустимых в deep link Telegram.
    expect(view.link).toMatch(/^https:\/\/t\.me\/deck_bot\?start=[A-Za-z0-9_-]{16}$/);
    const nonce = nonceOf(view.link);
    // Чужой и пустой /start окно не занимают: кандидата нет, окно ждёт дальше.
    bot.push(
      message(8, { text: '/start hello', from: 666 }),
      message(9, { text: '/start', from: 667 }),
    );
    await vi.waitFor(() =>
      expect(bot.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(2),
    );
    expect(window!.status().state).toBe('waiting');
    bot.push(message(10, { text: `/start ${nonce}`, first_name: 'Анна' }));
    await vi.waitFor(() => expect(window!.status().state).toBe('candidate'));
    expect(window!.status().candidate).toEqual({ id: '777', firstName: 'Анна', username: 'anna' });
    expect(window!.take()).toEqual({ id: '777', firstName: 'Анна', username: 'anna' });
    // Разобранное подтверждено: опрос ответов этот /start второй раз не получит.
    await vi.waitFor(() =>
      expect(bot.calls.filter((call) => call.method === 'getUpdates').at(-1)?.body).toMatchObject({
        offset: 11,
        timeout: 0,
      }),
    );
  });

  it('группа, не-/start и бот — мимо; кандидата нет', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    await make().open();
    bot.push(
      message(20, { type: 'group', chat: -100 }),
      message(21, { text: 'привет' }),
      message(22, { text: '/startle' }),
    );
    await vi.waitFor(() =>
      expect(bot.calls.filter((call) => call.method === 'getUpdates').length).toBeGreaterThan(2),
    );
    expect(window!.status().state).toBe('waiting');
    expect(window!.take()).toBeUndefined();
    // Тип чата судится сам по себе, а не через совпадение id чата и отправителя.
    expect(window!.offer(message(23, { type: 'supergroup' }))).toBe(false);
    expect(window!.offer(message(24, { type: 'channel' }))).toBe(false);
  });

  it('/start, пришедший до открытия окна, подтверждается и не читается', async () => {
    const bot = fakeBot({ old: [message(5)] });
    vi.stubGlobal('fetch', bot.fetchStub);
    await make().open();
    const drain = bot.calls.find((call) => call.method === 'getUpdates')!;
    expect(drain.body).toMatchObject({ offset: -1, timeout: 0 });
    await vi.waitFor(() =>
      expect(bot.calls.filter((call) => call.method === 'getUpdates')[1]?.body.offset).toBe(6),
    );
    expect(window!.status().state).toBe('waiting');
    // Отметка времени старше окна — тоже не кандидат, даже если дошла позже.
    expect(window!.offer(message(7, { date: 1 }))).toBe(false);
  });

  it('пять минут без /start — «истекло», подтвердить нечего', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    let now = 1_000_000;
    const win = make({ now: () => now, windowMs: 300_000 });
    await win.open();
    now += 300_001;
    expect(win.status().state).toBe('expired');
    expect(win.take()).toBeUndefined();
    expect(win.offer(message(30))).toBe(false);
  });

  it('бота уже слушает опрос ответов — своего опроса нет, /start приходит через offer', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const win = make({ serviceListens: () => true });
    const view = await win.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bot.calls.map((call) => call.method)).toEqual(['getMe']);
    expect(win.offer(message(39, { from: 555 }))).toBe(false);
    expect(win.offer(message(40, { from: 555, text: `/start ${nonceOf(view.link)}` }))).toBe(true);
    expect(win.status().candidate?.id).toBe('555');
  });

  it('новое окно — новый код: /start со ссылкой прежнего окна не принимается', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const win = make({ serviceListens: () => true });
    const first = nonceOf((await win.open()).link);
    const second = nonceOf((await win.open()).link);
    expect(second).not.toBe(first);
    expect(win.offer(message(41, { text: `/start ${first}` }))).toBe(false);
    expect(win.offer(message(42, { text: `/start@deck_bot ${second}` }))).toBe(true);
  });

  it('бот агента, нет токена — окно не открывается и Telegram не трогается', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    expect((await make({ agentBotIds: () => new Set(['123456789']) }).open()).reason).toBe(
      'same-bot',
    );
    expect((await make({ token: () => undefined }).open()).reason).toBe('no-token');
    expect(bot.calls).toEqual([]);
  });
});

describe('команды бота', () => {
  it('разбор: /status@bot — команда, неизвестная — other, текст — не команда', () => {
    expect(parseCommand('/status@deck_bot')).toBe('status');
    expect(parseCommand('/WAITING')).toBe('waiting');
    expect(parseCommand('/foo')).toBe('other');
    expect(parseCommand('привет')).toBeUndefined();
  });

  it('/status: работают с минутами, ждут, лимиты; неизвестные лимиты — без строки', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    const text = statusText({
      running: [{ project: 'shop', title: 'Починить вход', startedAt: now - 12 * 60_000 }],
      waiting: 2,
      limits: { session: 13, week: 62 },
      now,
    });
    expect(text).toBe(
      '⚙️ Работают: 1\n• 📁 shop · Починить вход · 12 мин\n⏳ Ждут тебя: 2\n📈 сессия 13% · неделя 62%',
    );
    expect(statusText({ running: [], waiting: 0, now })).toBe('⚙️ Работают: 0\n⏳ Ждут тебя: 0');
    // Сообщения уходят разметкой HTML: имя чата экранируется.
    expect(
      statusText({ running: [{ project: 'a&b', title: '<x>', startedAt: now }], waiting: 0, now }),
    ).toContain('• 📁 a&amp;b · &lt;x&gt; · 0 мин');
    // Проекта нет — нет и метки; нет ни проекта, ни имени — «Домашний чат».
    expect(
      statusText({ running: [{ project: '', title: 'Аудит', startedAt: now }], waiting: 0, now }),
    ).toContain('• Аудит · 0 мин');
    expect(statusText({ running: [{ project: '', startedAt: now }], waiting: 0, now })).toContain(
      '• Домашний чат · 0 мин',
    );
    // Ключ в имени чата закрыт маской до обрезки: хвост ключа не уходит в Telegram.
    const key = `sk-ant-api03-${'Q'.repeat(60)}`;
    const masked = statusText({
      running: [{ project: 'shop', title: `проверь ${key}`, startedAt: now }],
      waiting: 0,
      now,
    });
    expect(masked).not.toContain('QQQQQQQQ');
    expect(
      limitSharesOf({
        status: 'ok',
        windows: [
          { id: 'session', kind: 'session', percent: 13.4, resetsAt: null },
          { id: 'weekly', kind: 'weekly', percent: 62, resetsAt: null },
        ],
        observedAt: 1,
        source: 'oauth',
      }),
    ).toEqual({ session: 13, week: 62 });
    expect(limitSharesOf(undefined)).toBeUndefined();
  });
});

describe('TelegramAnswersService: команды владельца и меню', () => {
  let service: TelegramAnswersService | undefined;
  afterEach(() => {
    service?.stop();
    service = undefined;
  });

  const item = (key: string): PendingAskItem => ({
    key,
    target: { kind: 'permission', runKey: 'run-1', toolUseId: key },
    openId: 'sess-1',
    source: { project: 'shop', chatTitle: 'Починить вход', cli: 'Claude Code', app: 'agentdeck' },
    // Свежие: сами по `afterMinutes` ещё не ушли бы.
    askedAt: new Date().toISOString(),
    immediate: false,
    toolName: 'Bash',
    summary: 'git push',
  });

  async function make(over: Partial<AnswersServiceDeps> & { items?: PendingAskItem[] } = {}) {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 30, ownerId: OWNER, ownerName: '' });
    const items = over.items ?? [item('p1')];
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
      scanMs: 3_600_000,
      ...over,
    });
    await service.restart();
    return { bot, store, service };
  }

  const from = (text: string, id = Number(OWNER)): BotUpdate => ({
    update_id: 1,
    message: { message_id: 9, text, chat: { id, type: 'private' }, from: { id } },
  });
  const sent = (bot: ReturnType<typeof fakeBot>) =>
    bot.calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);

  it('при старте опроса — меню команд по-английски и по-русски', async () => {
    const { bot } = await make();
    await vi.waitFor(() =>
      expect(bot.calls.filter((call) => call.method === 'setMyCommands')).toHaveLength(2),
    );
    const menus = bot.calls.filter((call) => call.method === 'setMyCommands');
    expect(menus[0]!.body.language_code).toBeUndefined();
    expect(menus[1]!.body.language_code).toBe('ru');
    expect((menus[1]!.body.commands as { command: string }[]).map((c) => c.command)).toEqual([
      'status',
      'waiting',
      // Этап 12 (P193): `/task` — запись во «Входящие» доски ядра.
      'task',
      'clear',
      'help',
    ]);
  });

  it('/status — работают, ждут и лимиты одним сообщением владельцу', async () => {
    const { bot, service: svc } = await make({
      running: async () => [{ project: 'shop', title: 'Вход', startedAt: Date.now() - 60_000 }],
      limits: async () => ({ session: 13, week: 62 }),
    });
    await svc.handleUpdate(from('/status'));
    const [status] = sent(bot);
    expect(status!.chat_id).toBe(OWNER);
    expect(String(status!.text)).toContain('⚙️ Работают: 1');
    expect(String(status!.text)).toContain('• 📁 shop · Вход · 1 мин');
    expect(String(status!.text)).toContain('⏳ Ждут тебя: 1');
    expect(String(status!.text)).toContain('сессия 13% · неделя 62%');
  });

  it('/waiting — ждущее уходит сразу, мимо afterMinutes, с рабочими кнопками', async () => {
    const { bot, store, service: svc } = await make();
    await svc.scan();
    expect(sent(bot)).toHaveLength(0);
    await svc.handleUpdate(from('/waiting'));
    const [message] = sent(bot);
    expect(String(message!.text)).toContain('<b><code>git push</code></b>');
    expect(message!.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: '✅ Разрешить' }, {}]],
    });
    expect(store.wasSent('p1')).toBe(true);
    // Второй /waiting переносит ожидание в новое сообщение, прежнее теряет кнопки.
    await svc.handleUpdate(from('/waiting'));
    const edit = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit.body.text)).toContain('➡️ Ниже отдельным сообщением');
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(sent(bot)).toHaveLength(2);
  });

  it('/waiting без ожиданий — «ничего не ждёт»', async () => {
    const { bot, service: svc } = await make({ items: [] });
    await svc.handleUpdate(from('/waiting'));
    expect(sent(bot).map((body) => body.text)).toEqual(['✅ Ничего не ждёт ответа.']);
  });

  it('/help и любой текст не ответом — подсказка; /start подключённого — «уже подключено»', async () => {
    const { bot, service: svc } = await make();
    await svc.handleUpdate(from('/help'));
    await svc.handleUpdate(from('как дела'));
    await svc.handleUpdate(from('/start'));
    const texts = sent(bot).map((body) => String(body.text));
    expect(texts[0]).toContain('/status — что работает');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toMatch(/^✅ Уже подключено к AgentDeck\.\n\nКоманды:/);
  });

  it('команда не от владельца — тишина', async () => {
    const { bot, service: svc } = await make();
    await svc.handleUpdate(from('/status', 999));
    await svc.handleUpdate(from('/waiting', 999));
    expect(sent(bot)).toHaveLength(0);
  });

  it('/start в открытое окно подключения забирает окно, а не разбор владельца', async () => {
    const intercept = vi.fn((update: BotUpdate) => update.message?.text === '/start');
    const { bot, service: svc } = await make({ intercept });
    await svc.handleUpdate(from('/start'));
    expect(intercept).toHaveBeenCalledTimes(1);
    expect(sent(bot)).toHaveLength(0);
  });

  it('покрывает права и вопросы, только пока опрос жив и пишет владельцу без отказов', async () => {
    const { service: svc } = await make();
    expect(svc.covers()).toBe(true);
    expect(svc.listensTo(TOKEN)).toBe(true);
    svc.stop();
    expect(svc.listensTo(TOKEN)).toBe(false);
  });
});
