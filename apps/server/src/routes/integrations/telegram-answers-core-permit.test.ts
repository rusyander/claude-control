import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CORE_PERMIT_TOOL } from '@agentdeck/contracts/chat-handoff';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { buildInbox } from '../../domains/chat/chat-inbox/chat-inbox.ts';
import { applyAnswer, type Inject } from '../../domains/notify/telegram-answers/apply.ts';
import { collectPendingAsks } from '../../domains/notify/telegram-answers/collect.ts';
import { TelegramAnswersService } from '../../domains/notify/telegram-answers/service.ts';
import { AnswersStore } from '../../domains/notify/telegram-answers/store.ts';
import type { PendingAskItem } from '../../domains/notify/telegram-answers/telegram-answers.types.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { registerChatRunRoutes } from '../chat/run-routes/run-routes.ts';
import { permissionVanished } from './telegram-answers-routes.ts';

/**
 * Вопрос права задачи ядра и ответы из Telegram (этап 10, G5). Ответ ядру — human-strict: нужен
 * нонс окна с чистым пиром или подпись ключом телефона, а сервер панели — доверенный посредник,
 * его голос ядро не примет (W2-C). Поэтому вопрос ядра идёт в Telegram только уведомлением со
 * ссылкой (`core-relay`), без кнопок; а нажатие на старое сообщение, отправленное до этого правила,
 * получает названный отказ «ответ ядру — в панели или с телефона», а не ложное «Уже не актуально»
 * поверх вопроса, который по-прежнему ждёт. Маршрут решения, сессия и сводка — настоящие;
 * подделан только Bot API (сеть).
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';
const RUN = 'run-core';
const ASK = 'ask-core-1';

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

let root: string;
let app: FastifyInstance;
let registry: ChatRunRegistry;
let session: ChatSession;
let service: TelegramAnswersService | undefined;
let bot: ReturnType<typeof fakeBot>;
let settled: boolean;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-tg-core-permit-'));
  const appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  const ctx = {
    store: new AppStore(appData),
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        appData,
      },
    },
    backupDir: join(root, 'backups'),
    pricing: { current: () => ({ entries: [] }) },
    models: { current: () => ({ models: [] }) },
  } as unknown as ServerContext;
  registry = new ChatRunRegistry();
  session = new ChatSession(registry);
  app = Fastify();
  registerChatRunRoutes(app, ctx, registry, session);
  await app.ready();
  bot = fakeBot();
  vi.stubGlobal('fetch', bot.fetchStub);
  // Карточка ядра так, как её ставит ход задачи ядра в чате (`core-run`).
  settled = false;
  void session
    .requestPermission({
      runId: RUN,
      toolName: CORE_PERMIT_TOOL,
      input: { question: 'The step needs a grant to edit guarded/a1.txt (Write)' },
      toolUseId: ASK,
    })
    .then(() => (settled = true));
});

afterEach(async () => {
  service?.stop();
  service = undefined;
  vi.unstubAllGlobals();
  registry.stopAll();
  await app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const inject: Inject = async (request) => {
  const reply = await app.inject({
    method: request.method,
    url: request.url,
    ...(request.payload ? { payload: request.payload } : {}),
  });
  return { statusCode: reply.statusCode, body: reply.body };
};

/** Сводка ожиданий тем же путём, что у сервера: живые прогоны и карточки сессии → `buildInbox`. */
const collectLive = async (): Promise<PendingAskItem[]> =>
  collectPendingAsks({
    inbox: buildInbox({
      chats: [],
      runs: [{ key: RUN, projectPath: root, startedAt: Date.now(), prompt: 'core task' }],
      permissions: session.pendingPermissions(),
      lastAsked: () => undefined,
      now: Date.now(),
    }),
    defaultCli: 'Claude Code',
  });

/** Сообщение, отправленное ДО правила «вопрос ядра — без кнопок»: оно лежит в записи бота. */
const legacyItem = (): PendingAskItem => ({
  key: `p:${RUN}:${ASK}`,
  target: { kind: 'permission', runKey: RUN, toolUseId: ASK },
  openId: RUN,
  source: { project: 'probe', chatTitle: 'core task', cli: 'Claude Code', app: 'agentdeck' },
  askedAt: new Date().toISOString(),
  immediate: true,
  toolName: CORE_PERMIT_TOOL,
  summary: 'The step needs a grant to edit guarded/a1.txt (Write)',
});

async function start(collect: () => Promise<PendingAskItem[]>) {
  const store = new AnswersStore();
  store.setSettings({ enabled: true, afterMinutes: 0, ownerId: OWNER, ownerName: '' });
  service = new TelegramAnswersService({
    store,
    token: () => TOKEN,
    agentBotIds: () => new Set(),
    collect,
    apply: (target, answer, clientId) =>
      applyAnswer(target, answer, { inject, clientId, runParams: () => undefined }),
    vanished: (target) =>
      target.kind === 'permission'
        ? permissionVanished(session, target.runKey, target.toolUseId)
        : { kind: 'stale' },
    log: () => undefined,
    scanMs: 3_600_000,
    startupGraceMs: 0,
    confirmMissingMs: 0,
    sendGraceMs: 0,
  });
  await service.restart();
  await service.scan();
  return store;
}

const sentWithButtons = () =>
  bot.calls.filter((call) => call.method === 'sendMessage' && call.body.reply_markup);
const toastOf = (id: string) =>
  bot.calls.find(
    (call) => call.method === 'answerCallbackQuery' && call.body.callback_query_id === id,
  )?.body.text;
const lastEdit = () =>
  String(bot.calls.filter((call) => call.method === 'editMessageText').at(-1)?.body.text ?? '');

describe('вопрос права ядра и Telegram: только уведомление, ответ — в панели или с телефона', () => {
  it('маршрут решения на вопросе ядра — названный отказ coreOnly, не «уже нет»', async () => {
    const outcome = await applyAnswer(
      { kind: 'permission', runKey: RUN, toolUseId: ASK },
      { kind: 'decision', behavior: 'allow' },
      { inject, clientId: 'tg-1', runParams: () => undefined },
    );
    expect(outcome).toMatchObject({ ok: false, coreOnly: true });
    expect('gone' in outcome && outcome.gone).toBeFalsy();
    // Карточка не снята: ответ ядру ещё впереди.
    expect(session.pendingPermissions().map((p) => p.toolUseId)).toEqual([ASK]);
    expect(settled).toBe(false);
  });

  it('сводка не превращает вопрос ядра в сообщение с кнопками — его доставляет core-relay', async () => {
    expect(await collectLive()).toEqual([]);
    await start(collectLive);
    expect(sentWithButtons()).toHaveLength(0);
  });

  it('нажатие на старое сообщение — «🔒 Ответ ядру…», тост с адресом ответа, вопрос ждёт', async () => {
    let first = true;
    const store = await start(async () => {
      // Первый круг — запись старого сообщения; дальше сводка уже настоящая.
      if (first) {
        first = false;
        return [legacyItem()];
      }
      return collectLive();
    });
    const sent = sentWithButtons()[0];
    expect(sent).toBeDefined();
    const allow = (
      sent!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard
      .flat()
      .find((one) => one.text.includes('Разрешить'))!.callback_data;
    await service!.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-core',
        from: { id: Number(OWNER) },
        data: allow,
        message: { message_id: store.messages()[0]!.messageId, chat: { id: Number(OWNER) } },
      },
    });
    expect(toastOf('cb-core')).toBe('Ответ ядру — в панели или с телефона');
    expect(lastEdit()).toMatch(/^🔒 Ответ ядру — в панели или с телефона \d\d:\d\d/);
    expect(lastEdit()).not.toContain('Уже не актуально');
    expect(lastEdit()).not.toContain('Отвечено в панели');
    expect(session.pendingPermissions().map((p) => p.toolUseId)).toEqual([ASK]);
    expect(settled).toBe(false);
  });

  it('старое сообщение без нажатия — сверка закрывает его тем же «🔒», не «Уже не актуально»', async () => {
    let first = true;
    await start(async () => {
      if (first) {
        first = false;
        return [legacyItem()];
      }
      return collectLive();
    });
    expect(sentWithButtons()).toHaveLength(1);
    await service!.scan();
    await service!.scan();
    expect(lastEdit()).toMatch(/^🔒 Ответ ядру — в панели или с телефона \d\d:\d\d/);
    expect(lastEdit()).not.toContain('Уже не актуально');
  });
});
