import { afterEach, describe, expect, it, vi } from 'vitest';
import { telegramSettingsSchema } from '@agentdeck/contracts';
import type { TelegramNoticesHooks } from '../telegram-notices/telegram-notices.types.ts';
import { TelegramAnswersService, type AnswersServiceDeps } from './service.ts';
import { AnswersStore } from './store.ts';
import type { BotUpdate, PendingAskItem } from './telegram-answers.types.ts';

/**
 * Шов уведомлений ядра в сервисе ответов (этап 12, D29): строки-делегаты после проверки владельца —
 * нажатие `n:`, ответ на подсказку, `/task` и незнакомые команды, строки `/status`, тихие часы.
 * Крючок не взял — поведение прежнее; чужой отправитель до крючка не доходит. Подделан только
 * Bot API — `fetch`.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';

function fakeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 100;
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
      case 'getUpdates':
        // Опрос висит до отмены: обновления тест подаёт сам через `handleUpdate`.
        await new Promise<void>((resolve) =>
          init.signal?.addEventListener('abort', () => resolve()),
        );
        throw new Error('aborted');
      case 'sendMessage':
        nextId += 1;
        return ok({ message_id: nextId, chat: { id: Number(body.chat_id) } });
      default:
        return ok(true);
    }
  });
  return { calls, fetchStub };
}

function hooks(over: Partial<TelegramNoticesHooks> = {}): TelegramNoticesHooks {
  return {
    press: vi.fn(async () => true),
    reply: vi.fn(async () => true),
    command: vi.fn(async () => true),
    statusLines: vi.fn(async () => ['🧩 Ядро: 1 задача']),
    hold: vi.fn((items: readonly PendingAskItem[]) => items),
    ...over,
  };
}

const item = (key: string): PendingAskItem => ({
  key,
  openId: key,
  target: { kind: 'permission', runKey: 'run-1', toolUseId: key },
  source: { project: 'shop', chatTitle: 'Вход', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: new Date(0).toISOString(),
  immediate: true,
  toolName: 'Bash',
  summary: 'git push',
});

let service: TelegramAnswersService | undefined;
afterEach(() => {
  service?.stop();
  service = undefined;
  vi.unstubAllGlobals();
});

async function make(over: Partial<AnswersServiceDeps> = {}) {
  const bot = fakeBot();
  vi.stubGlobal('fetch', bot.fetchStub);
  const store = new AnswersStore();
  store.setSettings({ enabled: true, afterMinutes: 0, ownerId: OWNER, ownerName: '' });
  service = new TelegramAnswersService({
    store,
    sendGraceMs: 0,
    coalesceMs: 0,
    token: () => TOKEN,
    agentBotIds: () => new Set(),
    collect: async () => [],
    apply: async () => ({ ok: true }),
    vanished: () => ({ kind: 'inPanel' }),
    log: () => undefined,
    scanMs: 3_600_000,
    ...over,
  });
  await service.restart();
  const sent = () =>
    bot.calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
  return { bot, store, service, sent };
}

const text = (body: string, from = Number(OWNER), replyTo?: number): BotUpdate => ({
  update_id: 1,
  message: {
    message_id: 9,
    text: body,
    chat: { id: from, type: 'private' },
    from: { id: from },
    ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
  },
});
const press = (data: string, from = Number(OWNER)): BotUpdate => ({
  update_id: 2,
  callback_query: {
    id: 'cb1',
    from: { id: from },
    data,
    message: { message_id: 55, chat: { id: from, type: 'private' } },
  },
});

describe('telegram notices seam', () => {
  it('n: press goes to the hook with the update origin; a stranger never reaches it', async () => {
    const notices = hooks();
    const { service: svc, bot } = await make({ notices });
    await svc.handleUpdate(press('n:abc:1:AAAAAAAAAAAAAAAA', 999));
    expect(notices.press).not.toHaveBeenCalled();
    await svc.handleUpdate(press('n:abc:1:AAAAAAAAAAAAAAAA'));
    expect(notices.press).toHaveBeenCalledTimes(1);
    const [ctx] = vi.mocked(notices.press).mock.calls[0]!;
    expect(ctx.origin).toEqual({
      apiBase: 'https://api.telegram.org',
      botId: '123456789',
      chatId: OWNER,
      fromId: OWNER,
    });
    // Обработано крючком — сервис ответов тоста «устарело» не шлёт.
    expect(bot.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(false);
  });

  it('/task and unknown commands go to the hook; not taken → the old help text', async () => {
    const notices = hooks({
      command: vi.fn(async (_c, m) => m.text?.startsWith('/task') === true),
    });
    const { service: svc, sent } = await make({ notices });
    await svc.handleUpdate(text('/task починить вход'));
    expect(sent()).toHaveLength(0);
    await svc.handleUpdate(text('/foo'));
    expect(notices.command).toHaveBeenCalledTimes(2);
    expect(sent()[0]).toContain('/status — что работает');
  });

  it('reply to a notice prompt goes to the hook; not taken → old routing', async () => {
    const notices = hooks({ reply: vi.fn(async (_c, _m, to) => to === 77) });
    const { service: svc, sent } = await make({ notices });
    await svc.handleUpdate(text('доделай тесты', Number(OWNER), 77));
    expect(sent()).toHaveLength(0);
    await svc.handleUpdate(text('что-то', Number(OWNER), 78));
    expect(notices.reply).toHaveBeenCalledTimes(2);
    expect(sent()).toHaveLength(1);
  });

  it('/status gets the hook lines under the panel summary', async () => {
    const { service: svc, sent } = await make({ notices: hooks() });
    await svc.handleUpdate(text('/status'));
    expect(sent()[0]).toMatch(/⏳ Ждут тебя: 0\n🧩 Ядро: 1 задача$/);
  });

  it('quiet hold: what the hook keeps is not sent; without a hook everything is sent', async () => {
    const held = await make({
      collect: async () => [item('a'), item('b')],
      notices: hooks({
        hold: vi.fn((items: readonly PendingAskItem[]) => items.filter((i) => i.key !== 'b')),
      }),
    });
    await held.service.scan();
    expect(held.store.wasSent('a')).toBe(true);
    expect(held.store.wasSent('b')).toBe(false);
    service?.stop();
    vi.unstubAllGlobals();
    const plain = await make({ collect: async () => [item('a'), item('b')] });
    await plain.service.scan();
    expect([plain.store.wasSent('a'), plain.store.wasSent('b')]).toEqual([true, true]);
  });

  it('quiet hours setting: HH:MM pair, asks off by default, absent by default; a bad time is refused', () => {
    expect(telegramSettingsSchema.parse({}).quiet).toBeUndefined();
    expect(telegramSettingsSchema.parse({ quiet: { from: '23:00', to: '08:30' } }).quiet).toEqual({
      from: '23:00',
      to: '08:30',
      asks: false,
    });
    expect(
      telegramSettingsSchema.safeParse({ quiet: { from: '24:00', to: '08:00' } }).success,
    ).toBe(false);
  });
});
