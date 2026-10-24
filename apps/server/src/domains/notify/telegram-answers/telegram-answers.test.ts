import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInbox, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { applyAnswer, answerText, type InjectReply } from './apply.ts';
import {
  CALLBACK_DATA_LIMIT,
  newNonce,
  newSecret,
  parseCallback,
  signCallback,
  verifyCallback,
} from './callback-data.ts';
import { collectPendingAsks } from './collect.ts';
import { itemText, keyboardOf, messageText, panelLink } from './compose.ts';
import { TelegramAnswersService, type AnswersServiceDeps } from './service.ts';
import { AnswersStore } from './store.ts';
import type { PendingAskItem, SentMessage } from './telegram-answers.types.ts';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';

function chat(over: Partial<InboxChat> = {}): InboxChat {
  return {
    id: 'sess-1',
    runKey: 'run-1',
    sessionId: 'sess-1',
    title: 'Починить вход',
    project: 'shop',
    projectPath: 'C:/work/shop',
    isSandbox: false,
    status: 'waiting',
    running: true,
    updatedAt: '2026-10-23T10:00:00.000Z',
    asks: [],
    ...over,
  };
}

function inboxOf(chats: InboxChat[], deferred: ChatInbox['deferred'] = []): ChatInbox {
  return { generatedAt: '2026-10-23T10:00:00.000Z', chats, deferred };
}

const collectOf = (inbox: ChatInbox) =>
  collectPendingAsks({ inbox, foreign: [], defaultCli: 'Claude Code', cliName: (id) => id });

describe('callback-data', () => {
  it('подпись сходится только со своей солью и укладывается в 64 байта', () => {
    const secret = newSecret();
    const nonce = newNonce();
    const data = signCallback(secret, 'zz9', 37, nonce);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_LIMIT);
    const parsed = parseCallback(data)!;
    expect(parsed).toMatchObject({ sid: 'zz9', action: 37 });
    expect(verifyCallback(secret, parsed, nonce)).toBe(true);
    expect(verifyCallback(secret, parsed, newNonce())).toBe(false);
    expect(verifyCallback(newSecret(), parsed, nonce)).toBe(false);
    expect(verifyCallback(secret, { ...parsed, action: 38 }, nonce)).toBe(false);
    expect(parseCallback('t:zz9:37:short')).toBeUndefined();
    expect(parseCallback(undefined)).toBeUndefined();
  });
});

describe('collect', () => {
  it('собирает права, вопросы вызова одним ожиданием, хук, D-n; группа — сразу', () => {
    const items = collectOf(
      inboxOf(
        [
          chat({
            asks: [
              {
                kind: 'permission',
                key: 'p1',
                toolUseId: 'tu-1',
                toolName: 'Bash',
                input: {
                  command:
                    'curl -H "Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" x',
                },
                askedAt: '2026-10-23T10:00:00.000Z',
              },
              {
                kind: 'question',
                key: 'q:tu-2:0',
                toolUseId: 'tu-2',
                index: 0,
                total: 2,
                question: { question: 'Какой?', options: [{ label: 'A' }, { label: 'B' }] },
                askedAt: '2026-10-23T10:00:00.000Z',
              },
              {
                kind: 'question',
                key: 'q:tu-2:1',
                toolUseId: 'tu-2',
                index: 1,
                total: 2,
                question: { question: 'Где?', options: [{ label: 'X' }] },
                askedAt: '2026-10-23T10:00:00.000Z',
              },
            ],
          }),
          chat({
            id: 'sess-2',
            runKey: 'run-2',
            source: {
              app: 'agentdeck',
              cli: 'Claude Code',
              group: { index: 2, title: 'Тесты', stage: 'review' },
            },
            asks: [
              {
                kind: 'permission',
                key: 'p2',
                toolUseId: 'tu-3',
                toolName: 'Agent',
                input: { description: 'проверка' },
                askedAt: '2026-10-23T10:00:00.000Z',
                relay: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'D-4',
            state: 'waiting',
            kind: 'permission',
            toolName: 'Bash',
            summary: 'git push',
            reason: 'пуш',
            askedAt: '2026-10-23T09:00:00.000Z',
            expiresAt: '2026-10-30T09:00:00.000Z',
            chatId: 'sess-1',
          },
          {
            id: 'D-5',
            state: 'allowed',
            kind: 'permission',
            toolName: 'Bash',
            summary: 'x',
            reason: 'y',
            askedAt: '2026-10-23T09:00:00.000Z',
            expiresAt: '2026-10-30T09:00:00.000Z',
          },
        ],
      ),
    );
    expect(items.map((item) => item.key)).toEqual([
      'p:run-1:tu-1',
      'q:tu-2@sess-1',
      'rp:tu-3',
      'd:D-4@2026-10-23T09:00:00.000Z',
    ]);
    const [permission, question, relay, deferred] = items as [
      PendingAskItem,
      PendingAskItem,
      PendingAskItem,
      PendingAskItem,
    ];
    expect(permission.summary).not.toContain('sk-ant-api03-AAAA');
    expect(permission.immediate).toBe(false);
    expect(question.questions).toHaveLength(2);
    expect(question.target).toMatchObject({ kind: 'question', runKey: 'run-1' });
    expect(relay.immediate).toBe(true);
    expect(itemText(relay)).toContain('👥 Группа 2 «Тесты» · стадия «ревью»');
    expect(deferred).toMatchObject({ immediate: true, reason: 'пуш' });
  });
});

describe('compose', () => {
  const message = (items: SentMessage['items']): SentMessage => ({
    sid: '1',
    chatId: OWNER,
    messageId: 1,
    nonce: 'n',
    sentAt: '2026-10-23T10:00:00.000Z',
    items,
    actions: {},
    nextAction: 0,
  });
  const sign = (n: number) => `s${n}`;

  it('одно право — «Разрешить» и «Запретить»; вопрос — варианты и «Свой ответ»', () => {
    const perm = message([
      {
        key: 'a',
        target: { kind: 'permission', runKey: 'r', toolUseId: 't' },
        openId: 's',
        text: 'x',
        state: 'open',
      },
    ]);
    expect(
      keyboardOf(perm, sign)
        .flat()
        .map((button) => button.text),
    ).toEqual(['✅ Разрешить', '⛔ Запретить']);
    const question = message([
      {
        key: 'q',
        target: { kind: 'question', chatId: 'c', projectPath: 'p' },
        openId: 'c',
        text: 'x',
        questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }],
        step: 0,
        state: 'open',
      },
    ]);
    expect(
      keyboardOf(question, sign)
        .flat()
        .map((button) => button.text),
    ).toEqual(['A', 'B', '✍️ Свой ответ']);
    // Тот же кнопке — тот же номер: правка сообщения не сдвигает соседей.
    const first = keyboardOf(question, sign).flat()[1]!.callback_data;
    expect(keyboardOf(question, sign).flat()[1]!.callback_data).toBe(first);
  });

  it('сводное сообщение: вопрос — одной кнопкой «Ответить», ссылка на панель внизу', () => {
    const many = message([
      {
        key: 'a',
        target: { kind: 'permission', runKey: 'r', toolUseId: 't' },
        openId: 's1',
        text: 'право',
        state: 'open',
      },
      {
        key: 'q',
        target: { kind: 'question', chatId: 'c', projectPath: 'p' },
        openId: 'c',
        text: 'вопрос',
        questions: [{ question: 'Q?', options: [{ label: 'A' }] }],
        step: 0,
        state: 'open',
      },
    ]);
    const labels = keyboardOf(many, sign)
      .flat()
      .map((button) => button.text);
    expect(labels).toEqual(['1 · ✅ Разрешить', '1 · ⛔ Запретить', '2 · ❓ Ответить']);
    const text = messageText(many, [panelLink('s1', '8888')]);
    expect(text).toContain('Ждут ответа: 2');
    expect(text).toContain('Открыть в панели: http://localhost:8888/chat?id=s1');
  });
});

describe('apply', () => {
  const reply = (statusCode: number, body: unknown): InjectReply => ({
    statusCode,
    body: JSON.stringify(body),
  });

  it('решение по правам — маршрутом панели; 410 и {ok:false} — «уже нет»', async () => {
    const calls: unknown[] = [];
    const deps = (answer: InjectReply) => ({
      inject: async (request: unknown) => {
        calls.push(request);
        return answer;
      },
      runParams: () => undefined,
      clientId: 'tg-1',
    });
    const target = { kind: 'permission' as const, runKey: 'run 1', toolUseId: 'tu' };
    const decision = { kind: 'decision' as const, behavior: 'allow' as const };
    expect(await applyAnswer(target, decision, deps(reply(200, { ok: true })))).toEqual({
      ok: true,
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/chat/run%201/permission-decision',
      payload: { toolUseId: 'tu', behavior: 'allow' },
    });
    expect(await applyAnswer(target, decision, deps(reply(410, {})))).toMatchObject({
      gone: true,
    });
    expect(await applyAnswer(target, decision, deps(reply(200, { ok: false })))).toMatchObject({
      gone: true,
    });
    const missing = reply(404, { message: 'Route POST:/api/chat/deferred/D-1/decision not found' });
    expect(
      await applyAnswer({ kind: 'deferred', id: 'D-1' }, decision, deps(missing)),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('маршрут') });
    // D-n — тем же маршрутом решения, с подписью «из Telegram» для списка.
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      url: '/api/chat/deferred/D-1/decision',
      payload: { behavior: 'allow', via: 'telegram' },
    });
  });

  it('ответ на вопрос — сообщением в разговор с прежней моделью; поток — значит принят', async () => {
    let sent: { payload?: Record<string, unknown> } | undefined;
    const outcome = await applyAnswer(
      { kind: 'question', chatId: 'sess', sessionId: 'sess', projectPath: 'C:/p', runKey: 'run' },
      {
        kind: 'questions',
        questions: [
          { question: 'Какой?', header: 'Вариант', options: [] },
          { question: 'Где?', options: [] },
        ],
        picks: [['A'], ['X', 'Y']],
      },
      {
        inject: (request) => {
          sent = request;
          return new Promise(() => undefined);
        },
        runParams: () => ({ model: 'opus', effort: 'high', permissionMode: 'default' }),
        sendWaitMs: 10,
        clientId: 'tg-2',
      },
    );
    expect(outcome).toEqual({ ok: true });
    expect(sent?.payload).toMatchObject({
      chatId: 'run',
      prompt: 'Вариант: A\nГде?: X, Y',
      steer: true,
      queueIfBusy: true,
      clientId: 'tg-2',
      allowEdits: false,
      fullAccess: false,
      model: 'opus',
      effort: 'high',
    });
    expect(answerText([{ question: 'Q', options: [] }], [['A', 'B']])).toBe('A, B');
  });

  it('вопрос хука вне панели — {answers: {текст вопроса: выбранное}}', async () => {
    let body: unknown;
    await applyAnswer(
      { kind: 'relayQuestion', toolUseId: 'tu' },
      { kind: 'questions', questions: [{ question: 'Q?', options: [] }], picks: [['A']] },
      {
        inject: async (request) => {
          body = request;
          return reply(200, { ok: true });
        },
        runParams: () => undefined,
        clientId: 'x',
      },
    );
    expect(body).toEqual({
      method: 'POST',
      url: '/api/outside/asks/tu/answer',
      payload: { answers: { 'Q?': 'A' } },
    });
  });
});

// ── сервис на поддельном Bot API ────────────────────────────────────────────

interface BotCallLog {
  method: string;
  body: Record<string, unknown>;
}

function fakeBot(options: { webhook?: string; updates?: 'hang' | 409 } = {}) {
  const calls: BotCallLog[] = [];
  let nextMessageId = 100;
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (method) {
      case 'getMe':
        return ok({ id: 123456789, username: 'answers_bot' });
      case 'getWebhookInfo':
        return ok({ url: options.webhook ?? '' });
      case 'getUpdates':
        if (options.updates === 409) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 409, description: 'Conflict' }),
            { status: 409 },
          );
        }
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

describe('TelegramAnswersService', () => {
  let now = Date.parse('2026-10-23T10:10:00.000Z');
  let logs: string[];
  let service: TelegramAnswersService | undefined;

  beforeEach(() => {
    now = Date.parse('2026-10-23T10:10:00.000Z');
    logs = [];
  });
  afterEach(() => {
    service?.stop();
    vi.unstubAllGlobals();
  });

  const permissionItem = (over: Partial<PendingAskItem> = {}): PendingAskItem => ({
    key: 'p:run-1:tu-1',
    target: { kind: 'permission', runKey: 'run-1', toolUseId: 'tu-1' },
    openId: 'sess-1',
    source: { project: 'shop', chatTitle: 'Починить вход', cli: 'Claude Code', app: 'agentdeck' },
    askedAt: '2026-10-23T10:00:00.000Z',
    immediate: false,
    toolName: 'Bash',
    summary: 'git push',
    ...over,
  });

  function make(over: Partial<AnswersServiceDeps> & { items?: PendingAskItem[] } = {}) {
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 3, ownerId: OWNER });
    const items = over.items ?? [permissionItem()];
    const apply = vi.fn(async () => ({ ok: true as const }));
    service = new TelegramAnswersService({
      store,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect: async () => items,
      apply,
      vanished: () => ({ kind: 'inPanel' }),
      log: (line) => logs.push(line),
      now: () => now,
      scanMs: 3_600_000,
      startupGraceMs: 0,
      confirmMissingMs: 0,
      ...over,
    });
    return { store, items, apply, service };
  }

  it('бот агента — отказ «нужен отдельный бот», Telegram не трогается', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const { service: svc } = make({ agentBotIds: () => new Set(['123456789']) });
    const status = await svc.restart();
    expect(status.state).toBe('same-bot');
    expect(status.detail).toBe('для ответов из Telegram нужен отдельный бот');
    expect(bot.calls).toEqual([]);
  });

  it('вебхук — статус «webhook», deleteWebhook не зовётся', async () => {
    const bot = fakeBot({ webhook: 'https://example.com/hook' });
    vi.stubGlobal('fetch', bot.fetchStub);
    const { service: svc } = make();
    expect((await svc.restart()).state).toBe('webhook');
    expect(bot.calls.map((call) => call.method)).toEqual(['getMe', 'getWebhookInfo']);
  });

  it('409 на опросе — «conflict» и остановка без повтора вплотную', async () => {
    const bot = fakeBot({ updates: 409 });
    vi.stubGlobal('fetch', bot.fetchStub);
    const { service: svc } = make();
    await svc.restart();
    await vi.waitFor(() => expect(svc.status().state).toBe('conflict'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bot.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(1);
  });

  it('ожидание старше afterMinutes уходит с кнопками; нажатие владельца — маршрутом панели, итог в сообщении', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const { store, apply, service: svc } = make();
    await svc.restart();
    await svc.scan();
    const sent = bot.calls.find((call) => call.method === 'sendMessage')!;
    expect(sent.body.chat_id).toBe(OWNER);
    expect(String(sent.body.text)).toContain('📁 shop · 💬 Починить вход · Claude Code');
    const keyboard = (sent.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    const allow = keyboard[0]![0]!.callback_data;
    expect(Buffer.byteLength(allow)).toBeLessThanOrEqual(64);
    const messageId = store.messages()[0]!.messageId;
    const press = (from: number, data = allow, chatId = Number(OWNER)) => ({
      update_id: 1,
      callback_query: {
        id: 'cb',
        from: { id: from },
        data,
        message: { message_id: messageId, chat: { id: chatId } },
      },
    });

    // Чужой — молча мимо, в журнале нет ни данных, ни id.
    await svc.handleUpdate(press(999));
    await svc.handleUpdate(press(Number(OWNER), allow, 999));
    expect(apply).not.toHaveBeenCalled();
    // Поддельная подпись — «уже не актуально», без применения.
    await svc.handleUpdate(
      press(Number(OWNER), `${allow.slice(0, -1)}${allow.endsWith('A') ? 'B' : 'A'}`),
    );
    expect(apply).not.toHaveBeenCalled();

    await svc.handleUpdate(press(Number(OWNER)));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]).toEqual([
      { kind: 'permission', runKey: 'run-1', toolUseId: 'tu-1' },
      { kind: 'decision', behavior: 'allow' },
      expect.stringMatching(/^tg-/),
    ]);
    const edit = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit.body.text)).toMatch(/✅ Разрешено · \d\d:\d\d/);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });

    // Повтор нажатия — «уже отвечено», второго применения нет.
    await svc.handleUpdate(press(Number(OWNER)));
    expect(apply).toHaveBeenCalledTimes(1);
    const toasts = bot.calls
      .filter((call) => call.method === 'answerCallbackQuery')
      .map((call) => call.body.text);
    expect(toasts).toEqual(['Уже не актуально', 'Принято', 'Уже отвечено']);

    expect(logs.join('\n')).not.toContain('999');
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(svc.status())).not.toContain(TOKEN);
  });

  it('свежее ожидание ждёт afterMinutes, группа уходит сразу; одно сообщение в минуту', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const fresh = permissionItem({ askedAt: '2026-10-23T10:09:00.000Z' });
    const items = [fresh];
    const { service: svc } = make({ items });
    await svc.restart();
    await svc.scan();
    expect(bot.calls.some((call) => call.method === 'sendMessage')).toBe(false);
    items.push(permissionItem({ key: 'g', immediate: true, askedAt: '2026-10-23T10:09:59.000Z' }));
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    now += 3 * 60_000;
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2);
  });

  it('D-n, открытая заново под прежним номером, приходит в Telegram снова (RF-DL-07, живой T3)', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const record = (askedAt: string): ChatInbox['deferred'] => [
      {
        id: 'D-1',
        state: 'waiting',
        kind: 'permission',
        toolName: 'Bash',
        summary: 'git push',
        reason: 'пуш',
        askedAt,
        expiresAt: '2026-10-30T09:00:00.000Z',
        chatId: 'sess-1',
      },
    ];
    let inbox = inboxOf([], record('2026-10-23T10:00:00.000Z'));
    const { service: svc } = make({ collect: async () => collectOf(inbox) });
    await svc.restart();
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    // Запись истекла, агент повторил вызов — тот же номер открыт заново.
    now += 60_000;
    inbox = inboxOf([], record('2026-10-23T10:11:00.000Z'));
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2);
    // Та же открытая запись второй раз не уходит.
    now += 60_000;
    await svc.scan();
    expect(bot.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2);
  });

  it('ответили в панели — сообщение правится «Отвечено в панели», кнопки снимаются', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const items = [permissionItem()];
    const { service: svc } = make({ items });
    await svc.restart();
    await svc.scan();
    items.length = 0;
    await svc.scan();
    const edit = bot.calls.filter((call) => call.method === 'editMessageText').pop()!;
    expect(String(edit.body.text)).toMatch(/💻 Отвечено в панели · \d\d:\d\d/);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('вопрос: выбор варианта отвечает; «Свой ответ» — ответом на ForceReply', async () => {
    const bot = fakeBot();
    vi.stubGlobal('fetch', bot.fetchStub);
    const question: PendingAskItem = {
      key: 'q',
      target: { kind: 'question', chatId: 'sess-1', projectPath: 'C:/p' },
      openId: 'sess-1',
      source: { project: 'shop', chatTitle: 't', cli: 'Claude Code', app: 'agentdeck' },
      askedAt: '2026-10-23T10:00:00.000Z',
      immediate: false,
      questions: [
        { question: 'Первый?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Второй?', options: [{ label: 'X' }] },
      ],
    };
    const { store, apply, service: svc } = make({ items: [question] });
    await svc.restart();
    await svc.scan();
    const message = store.messages()[0]!;
    const keyboardOfLast = () => {
      const last = [...bot.calls]
        .reverse()
        .find((call) => call.method === 'sendMessage' || call.method === 'editMessageText')!;
      return (
        last.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
      ).inline_keyboard.flat();
    };
    const press = (data: string) => ({
      update_id: 1,
      callback_query: {
        id: 'cb',
        from: { id: Number(OWNER) },
        data,
        message: { message_id: message.messageId, chat: { id: Number(OWNER) } },
      },
    });
    await svc.handleUpdate(
      press(keyboardOfLast().find((button) => button.text === 'B')!.callback_data),
    );
    expect(apply).not.toHaveBeenCalled();
    await svc.handleUpdate(
      press(keyboardOfLast().find((button) => button.text === '✍️ Свой ответ')!.callback_data),
    );
    const prompt = bot.calls.filter((call) => call.method === 'sendMessage').pop()!;
    expect(prompt.body.reply_markup).toMatchObject({ force_reply: true });
    await svc.handleUpdate({
      update_id: 2,
      message: {
        message_id: 500,
        chat: { id: Number(OWNER) },
        from: { id: Number(OWNER) },
        text: 'своё',
        reply_to_message: { message_id: message.items[0]!.customPrompt! },
      },
    });
    expect(apply).toHaveBeenCalledWith(
      question.target,
      { kind: 'questions', questions: question.questions, picks: [['B'], ['своё']] },
      expect.any(String),
    );
  });
});

describe('AnswersStore › битый файл (RF-DL-08, живой T1)', () => {
  it('панель стартует: файл отведён `.bad-…`, потеря в журнале, настройка с чистого', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-answers-'));
    try {
      writeFileSync(join(dir, 'telegram-answers.json'), '{"version":1,"settings":{"enab');
      const lines: string[] = [];
      const store = new AnswersStore(dir, (message) => lines.push(message));
      expect(store.settings.enabled).toBe(false);
      expect(store.lost).toMatch(/telegram-answers\.json\.bad-/);
      expect(lines.join('\n')).toContain('is not readable');
      const names = readdirSync(dir);
      expect(names.some((name) => name.startsWith('telegram-answers.json.bad-'))).toBe(true);
      // Свежий файл лёг на место: следующий старт читает его без потерь.
      expect(names).toContain('telegram-answers.json');
      expect(new AnswersStore(dir, () => undefined).lost).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
