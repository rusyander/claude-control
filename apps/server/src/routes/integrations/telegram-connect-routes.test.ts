import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  TelegramAnswersView,
  TelegramConnectView,
} from '@agentdeck/contracts/telegram-answers';
import type { ServerContext } from '../../context.ts';
import type { BotUpdate } from '../../domains/notify/telegram-answers/telegram-answers.types.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { setStoredKey } from '../../lib/provider-keys/provider-keys.ts';
import {
  registerTelegramAnswersRoutes,
  type TelegramAnswersRouteDeps,
} from './telegram-answers-routes.ts';

/**
 * Подключение по /start на настоящих маршрутах: окно → `/start` в личном чате →
 * подтверждение пишет чат уведомлений, владельца ответов и включает оба, бот
 * здоровается на языке панели. Подделан только Bot API (сеть). Что маршруты
 * закрыты процессу модели (403), проверяет живая сборка в `ledger-gate.test.ts`.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';

function fakeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const queue: BotUpdate[] = [];
  let wake: (() => void) | undefined;
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
        if (body.offset === -1) return ok([]);
        if (queue.length === 0 && Number(body.timeout) > 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            init.signal?.addEventListener('abort', () => resolve());
          });
        }
        if (init.signal?.aborted) throw new Error('aborted');
        return ok(queue.splice(0));
      case 'sendMessage':
        return ok({ message_id: 1, chat: { id: Number(body.chat_id) } });
      default:
        return ok(true);
    }
  });
  const push = (update: BotUpdate) => {
    queue.push(update);
    wake?.();
  };
  return { calls, fetchStub, push };
}

/** `/start <код>` — код окна из ссылки `t.me/<бот>?start=<код>`. */
const start = (id: number, from: number, code: string, type = 'private'): BotUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text: code ? `/start ${code}` : '/start',
    chat: { id: type === 'private' ? from : -100, type },
    from: { id: from, first_name: 'Анна', username: 'anna' },
  },
});

const codeOf = (view: TelegramConnectView): string =>
  new URL(view.link ?? 'https://t.me/x').searchParams.get('start') ?? '';

describe('подключение бота по /start (маршруты)', () => {
  let root: string;
  let app: FastifyInstance;
  let ctx: ServerContext;
  let bot: ReturnType<typeof fakeBot>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tg-connect-'));
    const appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    setStoredKey(appData, 'int:telegram', TOKEN);
    ctx = {
      store: new AppStore(appData),
      location: {
        paths: {
          root,
          appData,
          mcpConfig: join(root, '.claude.json'),
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          secretsEnv: join(root, 'secrets.env'),
        },
      },
    } as unknown as ServerContext;
    bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    app = Fastify();
    const deps = {
      registry: { active: () => [] },
      session: {},
      providerChats: { pendingAsks: () => [], runningChats: () => [] },
      cover: { covers: () => false },
    } as unknown as TelegramAnswersRouteDeps;
    registerTelegramAnswersRoutes(app, ctx, deps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  const call = async <T>(method: 'GET' | 'POST', url: string) => {
    const reply = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    return { status: reply.statusCode, body: JSON.parse(reply.body) as T };
  };

  it('окно → чужая группа и личный /start → до подтверждения ничего не записано → подтверждение пишет и здоровается', async () => {
    const opened = await call<TelegramConnectView>('POST', '/api/integrations/telegram/connect');
    expect(opened.body).toMatchObject({ state: 'waiting' });
    expect(opened.body.link).toMatch(/^https:\/\/t\.me\/deck_bot\?start=[A-Za-z0-9_-]{16}$/);
    const code = codeOf(opened.body);

    bot.push(start(1, 555, code, 'group'));
    // Посторонний без кода окна окно не занимает.
    bot.push(start(5, 999, ''));
    bot.push(start(2, 777, code));
    await vi.waitFor(async () =>
      expect(
        (await call<TelegramConnectView>('GET', '/api/integrations/telegram/connect')).body,
      ).toMatchObject({ state: 'candidate', candidate: { id: '777', firstName: 'Анна' } }),
    );
    // Кандидат — ещё не владелец.
    expect(ctx.store.getSettings().integrations.telegram.chatId).toBe('');
    const before = await call<TelegramAnswersView>('GET', '/api/integrations/telegram/answers');
    expect(before.body.settings).toMatchObject({ enabled: false, ownerId: '' });

    const confirmed = await call<TelegramConnectView>(
      'POST',
      '/api/integrations/telegram/connect/confirm',
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe('confirmed');
    expect(ctx.store.getSettings().integrations.telegram).toMatchObject({
      enabled: true,
      chatId: '777',
    });
    // Подключились, чтобы звали, когда агент ждёт: группа «Агент ждёт тебя» отмечена,
    // и включённые ответы с кнопками не висят под снятой галочкой.
    expect(ctx.store.getSettings().integrations.telegram.events).toEqual(
      expect.arrayContaining(['permission', 'question']),
    );
    const after = await call<TelegramAnswersView>('GET', '/api/integrations/telegram/answers');
    // Имя — из подтверждения: карточка пишет «Вы: Анна (@anna)», а не голый id.
    expect(after.body.settings).toMatchObject({
      enabled: true,
      ownerId: '777',
      ownerName: 'Анна (@anna)',
    });
    const greeting = bot.calls.find((entry) => entry.method === 'sendMessage')!;
    expect(greeting.body.chat_id).toBe('777');
    expect(String(greeting.body.text)).toContain('Подключено к AgentDeck');
    // После подтверждения бота слушает опрос ответов того же токена.
    await vi.waitFor(() => expect(after.body.status.state).toBe('polling'));
  });

  it('подтверждать некого — 409 и ничего не записано; закрытое окно — тоже; язык панели en — приветствие по-английски', async () => {
    expect((await call('POST', '/api/integrations/telegram/connect/confirm')).status).toBe(409);
    bot.push(
      start(
        3,
        777,
        codeOf(
          (await call<TelegramConnectView>('POST', '/api/integrations/telegram/connect')).body,
        ),
      ),
    );
    await vi.waitFor(async () =>
      expect(
        (await call<TelegramConnectView>('GET', '/api/integrations/telegram/connect')).body.state,
      ).toBe('candidate'),
    );
    await call('POST', '/api/integrations/telegram/connect/cancel');
    expect((await call('POST', '/api/integrations/telegram/connect/confirm')).status).toBe(409);
    expect(ctx.store.getSettings().integrations.telegram.chatId).toBe('');

    ctx.store.updateSettings({ language: 'en' });
    bot.push(
      start(
        4,
        778,
        codeOf(
          (await call<TelegramConnectView>('POST', '/api/integrations/telegram/connect')).body,
        ),
      ),
    );
    await vi.waitFor(async () =>
      expect(
        (await call<TelegramConnectView>('GET', '/api/integrations/telegram/connect')).body.state,
      ).toBe('candidate'),
    );
    await call('POST', '/api/integrations/telegram/connect/confirm');
    const greeting = bot.calls.filter((entry) => entry.method === 'sendMessage').pop()!;
    expect(greeting.body.chat_id).toBe('778');
    expect(String(greeting.body.text)).toContain('Connected to AgentDeck');
  });

  // Живой прогон владельца 25.10: ответы включили, когда у карточки ещё не было
  // токена, — опрос встал в «нет токена». Сохранённый потом токен карточки опрос
  // не будил: ни одного обновления, ни одного сообщения до перезапуска панели.
  it('токен карточки сохранён или забыт — опрос ответов перезапускается сам', async () => {
    await app.close();
    rmSync(join(ctx.location.paths.appData, 'provider-keys.enc'), { force: true });
    app = Fastify();
    // Тот же адрес, что у карточки (`connector-routes.ts`): его ответ — повод.
    app.put<{ Params: { id: string } }>('/api/integrations/:id', async () => {
      setStoredKey(ctx.location.paths.appData, 'int:telegram', TOKEN);
      return { ok: true };
    });
    registerTelegramAnswersRoutes(app, ctx, {
      registry: { active: () => [] },
      session: {},
      providerChats: { pendingAsks: () => [], runningChats: () => [] },
    } as unknown as TelegramAnswersRouteDeps);
    await app.ready();
    ctx.store.updateSettings({
      integrations: {
        ...ctx.store.getSettings().integrations,
        telegram: { enabled: true, chatId: '777', events: [] },
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/integrations/telegram/answers',
      payload: { enabled: true, ownerId: '777' },
    });
    const before = await call<TelegramAnswersView>('GET', '/api/integrations/telegram/answers');
    expect(before.body.status.state).toBe('no-token');
    await app.inject({ method: 'PUT', url: '/api/integrations/telegram', payload: {} });
    await vi.waitFor(async () =>
      expect(
        (await call<TelegramAnswersView>('GET', '/api/integrations/telegram/answers')).body.status
          .state,
      ).toBe('polling'),
    );
  });

  it('id владельца сменили руками — прежнее имя не приписывается новому id', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/integrations/telegram/answers',
      payload: { ownerId: '777' },
    });
    const store = join(ctx.location.paths.appData, 'telegram-answers.json');
    const raw = JSON.parse(readFileSync(store, 'utf8')) as { settings: Record<string, unknown> };
    raw.settings.ownerName = 'Анна (@anna)';
    writeFileSync(store, JSON.stringify(raw));
    await app.close();
    app = Fastify();
    registerTelegramAnswersRoutes(app, ctx, {
      registry: { active: () => [] },
      session: {},
      providerChats: { pendingAsks: () => [], runningChats: () => [] },
    } as unknown as TelegramAnswersRouteDeps);
    await app.ready();
    const same = await app.inject({
      method: 'PUT',
      url: '/api/integrations/telegram/answers',
      payload: { ownerId: '777', afterMinutes: 5 },
    });
    expect((JSON.parse(same.body) as TelegramAnswersView).settings.ownerName).toBe('Анна (@anna)');
    const other = await app.inject({
      method: 'PUT',
      url: '/api/integrations/telegram/answers',
      payload: { ownerId: '888' },
    });
    expect((JSON.parse(other.body) as TelegramAnswersView).settings.ownerName).toBe('');
  });

  it('главный выключатель карточки выключен — опрос ответов стоит', async () => {
    ctx.store.updateSettings({
      integrations: {
        ...ctx.store.getSettings().integrations,
        telegram: { enabled: false, chatId: '777', events: [] },
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/integrations/telegram/answers',
      payload: { enabled: true, ownerId: '777' },
    });
    const view = await call<TelegramAnswersView>('GET', '/api/integrations/telegram/answers');
    expect(view.body.status.state).toBe('off');
    expect(bot.calls.filter((entry) => entry.method === 'getUpdates')).toHaveLength(0);
  });
});
