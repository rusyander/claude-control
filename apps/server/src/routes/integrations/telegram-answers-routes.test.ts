import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import type { ServerContext } from '../../context.ts';
import { DeferredAsks } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import { applyAnswer, type Inject } from '../../domains/notify/telegram-answers/apply.ts';
import { collectPendingAsks } from '../../domains/notify/telegram-answers/collect.ts';
import { TelegramAnswersService } from '../../domains/notify/telegram-answers/service.ts';
import { AnswersStore } from '../../domains/notify/telegram-answers/store.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import {
  inboxDeferredOf,
  registerDeferredRoutes,
} from '../chat/deferred-routes/deferred-routes.ts';
import { deferredAsksOf } from '../chat/deferred-routes/deferred-store.ts';
import { deferredVanished } from './telegram-answers-routes.ts';

/**
 * Telegram и D-n на НАСТОЯЩЕМ маршруте решения (`/api/chat/deferred/:id/decision`):
 * нажатие уходит тем же `app.inject`, что у сервера, запись — настоящая
 * `DeferredAsks` в папке данных, сводка — `inboxDeferredOf` → `collectPendingAsks`.
 * Подделан только Bot API (сеть). Холодное ревью 23.10: D-L03 — нажатие на уже
 * решённый в панели D-n отвечало «Принято» и «✅ Разрешено» поверх отказа;
 * D-L04 — решённый в панели D-n закрывался «⌛ Уже не актуально».
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';

interface BotCall {
  method: string;
  body: Record<string, unknown>;
}

function fakeBot() {
  const calls: BotCall[] = [];
  let nextMessageId = 100;
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (method) {
      case 'getMe':
        return ok({ id: 987654321, username: 'answers_bot' });
      case 'getWebhookInfo':
        return ok({ url: '' });
      case 'getUpdates':
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      case 'sendMessage':
        nextMessageId += 1;
        return ok({ message_id: nextMessageId, chat: { id: Number(OWNER) } });
      default:
        return ok(true);
    }
  });
  return { calls, fetchStub };
}

describe('Telegram и D-n на настоящем маршруте решения', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let service: TelegramAnswersService | undefined;
  let bot: ReturnType<typeof fakeBot>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tg-deferred-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    ctx = {
      store: new AppStore(appData),
      location: { paths: { root, appData } },
    } as unknown as ServerContext;
    app = Fastify();
    registerDeferredRoutes(app, ctx, { allProcessRoots: () => [] });
    await app.ready();
    bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
  });

  afterEach(async () => {
    service?.stop();
    service = undefined;
    vi.unstubAllGlobals();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const inject: Inject = async (request) => {
    const reply = await app.inject({
      method: request.method,
      url: request.url,
      ...(request.payload ? { payload: request.payload } : {}),
    });
    return { statusCode: reply.statusCode, body: reply.body };
  };

  const seed = (command = 'npm publish --access public') =>
    deferredAsksOf(ctx).ask({
      scope: { kind: 'group', parentChatId: 'parent', groupIndex: 0 },
      runKeys: ['group-chat'],
      toolName: 'Bash',
      input: { command },
      toolUseId: `toolu_${command.length}`,
      reason: 'human gate',
    }).record;

  /** Решение «из панели» — тот же маршрут, что у окна. */
  const decideInPanel = async (id: string, behavior: 'allow' | 'deny') => {
    const reply = await inject({
      method: 'POST',
      url: `/api/chat/deferred/${id}/decision`,
      payload: { behavior, via: 'web' },
    });
    expect(reply.statusCode).toBe(200);
  };

  /** Сервис с настоящими сводкой, применением и закрытием, как в `registerTelegramAnswersRoutes`. */
  async function start() {
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: OWNER });
    service = new TelegramAnswersService({
      store,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () =>
        collectPendingAsks({
          inbox: { chats: [], deferred: inboxDeferredOf(ctx) } as unknown as ChatInbox,
          foreign: [],
          defaultCli: 'Claude Code',
          cliName: (id) => id,
        }),
      apply: (target, answer, clientId) =>
        applyAnswer(target, answer, { inject, clientId, runParams: () => undefined }),
      vanished: (target) =>
        target.kind === 'deferred'
          ? deferredVanished(deferredAsksOf(ctx), target.id)
          : { kind: 'stale' },
      log: () => undefined,
      scanMs: 3_600_000,
      startupGraceMs: 0,
      confirmMissingMs: 0,
    });
    await service.restart();
    await service.scan();
    const sent = bot.calls.find((call) => call.method === 'sendMessage');
    expect(sent).toBeDefined();
    const buttons = (
      sent!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
    const button = (label: string) =>
      buttons.find((one) => one.text.includes(label))!.callback_data;
    const messageId = store.messages()[0]!.messageId;
    const press = async (label: string, id: string) => {
      await service!.handleUpdate({
        update_id: 1,
        callback_query: {
          id,
          from: { id: Number(OWNER) },
          data: button(label),
          message: { message_id: messageId, chat: { id: Number(OWNER) } },
        },
      });
    };
    return { press };
  }

  const toastOf = (id: string) =>
    bot.calls.find(
      (call) => call.method === 'answerCallbackQuery' && call.body.callback_query_id === id,
    )?.body.text;
  const lastEdit = () =>
    String(bot.calls.filter((call) => call.method === 'editMessageText').at(-1)?.body.text ?? '');

  it('запретили в панели, потом «Разрешить» в Telegram — «Уже отвечено», «💻 Отвечено в панели», запись не тронута', async () => {
    const record = seed();
    const { press } = await start();
    await decideInPanel(record.id, 'deny');
    await press('Разрешить', 'cb-race');
    expect(toastOf('cb-race')).toBe('Уже отвечено');
    expect(lastEdit()).toMatch(/💻 Отвечено в панели · \d\d:\d\d/);
    expect(lastEdit()).not.toContain('✅ Разрешено');
    const after = deferredAsksOf(ctx).get(record.id);
    expect(after?.state).toBe('denied');
    expect(after?.decidedVia).toBe('web');
  });

  it('разрешили в панели, поздний «Запретить» — «Уже отвечено», запись разрешена', async () => {
    const record = seed();
    const { press } = await start();
    await decideInPanel(record.id, 'allow');
    await press('Запретить', 'cb-late');
    expect(toastOf('cb-late')).toBe('Уже отвечено');
    expect(lastEdit()).toMatch(/💻 Отвечено в панели/);
    expect(lastEdit()).not.toContain('⛔ Запрещено');
    expect(deferredAsksOf(ctx).get(record.id)?.state).toBe('allowed');
  });

  it('решили в панели без нажатия — сверка закрывает «💻 Отвечено в панели», не «Уже не актуально»', async () => {
    const record = seed();
    await start();
    await decideInPanel(record.id, 'deny');
    await service!.scan();
    expect(lastEdit()).toMatch(/💻 Отвечено в панели · \d\d:\d\d/);
    expect(lastEdit()).not.toContain('⌛ Уже не актуально');
  });

  it('D-n отозван (отмена плана, «Убрать» группу) — сообщение закрыто «⌛ Уже не актуально», нажатие ничего не решает (RF-DL-10)', async () => {
    const record = seed();
    await start();
    deferredAsksOf(ctx).withdraw((scope) => scope.kind === 'group');
    await service!.scan();
    expect(lastEdit()).toMatch(/⌛ Уже не актуально · \d\d:\d\d/);
    expect(lastEdit()).not.toContain('💻 Отвечено в панели');
    expect(deferredAsksOf(ctx).get(record.id)?.state).toBe('withdrawn');
  });

  it('нажатие раньше сверки на отозванный D-n — «Уже не актуально», запись не оживает (RF-DL-10)', async () => {
    const record = seed();
    const { press } = await start();
    deferredAsksOf(ctx).withdraw((scope) => scope.kind === 'group');
    await press('Разрешить', 'cb-gone');
    expect(toastOf('cb-gone')).toBe('Уже не актуально');
    expect(lastEdit()).toMatch(/⌛ Уже не актуально · \d\d:\d\d/);
    expect(deferredAsksOf(ctx).get(record.id)?.state).toBe('withdrawn');
  });

  it('нажатие на ждущий D-n — «Принято», решение записано из Telegram', async () => {
    const record = seed();
    const { press } = await start();
    await press('Разрешить', 'cb-own');
    expect(toastOf('cb-own')).toBe('Принято');
    expect(lastEdit()).toMatch(/✅ Разрешено · \d\d:\d\d/);
    const after = deferredAsksOf(ctx).get(record.id);
    expect(after?.state).toBe('allowed');
    expect(after?.decidedVia).toBe('telegram');
  });
});

describe('deferredVanished', () => {
  const scope = { kind: 'group' as const, parentChatId: 'parent', groupIndex: 0 };

  it('решён — «в панели»; истёк, отозван, нет записи — «уже не актуально»', () => {
    let now = Date.parse('2026-10-23T10:00:00.000Z');
    const asks = new DeferredAsks({ now: () => now, ttlMs: () => 60_000, grantMs: 60_000 });
    const ask = (command: string) =>
      asks.ask({ scope, runKeys: ['c'], toolName: 'Bash', input: { command }, reason: 'r' }).record
        .id;
    const denied = ask('a');
    const allowed = ask('b');
    const consumed = ask('c');
    const expired = ask('d');
    asks.decide(denied, { behavior: 'deny', via: 'web' });
    asks.decide(allowed, { behavior: 'allow', via: 'mobile' });
    asks.decide(consumed, { behavior: 'allow', via: 'web' });
    asks.consume(scope, 'Bash', { command: 'c' });
    expect(deferredVanished(asks, denied)).toEqual({ kind: 'inPanel' });
    expect(deferredVanished(asks, allowed)).toEqual({ kind: 'inPanel' });
    expect(deferredVanished(asks, consumed)).toEqual({ kind: 'inPanel' });
    expect(deferredVanished(asks, 'D-99')).toEqual({ kind: 'stale' });

    // Срок ожидания вышел без ответа — ответа не было, «отвечено» было бы ложью.
    now += 61_000;
    expect(asks.get(expired)?.state).toBe('expired');
    expect(deferredVanished(asks, expired)).toEqual({ kind: 'stale' });
  });
});
