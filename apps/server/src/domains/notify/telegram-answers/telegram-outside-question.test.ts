import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInbox, InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';
import { readChats } from '../../chat/ChatHistory/ChatHistory.ts';
import { buildInbox } from '../../chat/chat-inbox/chat-inbox.ts';
import { createTranscriptTailReader } from '../../chat/chat-inbox/transcript-tail.ts';
import { applyAnswer, sendChatText, type Inject, type InjectRequest } from './apply.ts';
import { collectPendingAsks } from './collect.ts';
import { keyboardOf, messageText, sentItemOf } from './compose.ts';
import { TelegramAnswersService } from './service.ts';
import { AnswersStore } from './store.ts';
import type { PendingAskItem, SentMessage } from './telegram-answers.types.ts';

/**
 * Вопрос сессии, которую панель не ведёт (VS Code, терминал), а хук панели не
 * держит. Живой прогон 25.10 (сессия e6600235): Telegram показал варианты
 * кнопками, нажатие ушло `POST /api/chat/send` — панель продолжила сессию VS Code
 * своим `claude -p --resume` и отправила «Вариант A» новым сообщением, а диалог
 * в VS Code так и висел. Такой вопрос — только для чтения: тот же вид, без
 * кнопок, со строкой «Ответь в VS Code». Взял его хук позже — то же сообщение
 * получает кнопки, второго нет.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = 4242;
const SESSION = 'e6600235-aae9-4656-9743-7f40a74e61f5';
const LINK = `http://127.0.0.1:8888/chat?id=${SESSION}`;
const OPEN = `<a href="${LINK}">Открыть чат →</a>`;
const QUESTION = {
  question: 'Какой вариант выбираешь?',
  header: 'Вариант',
  options: [{ label: 'Вариант A' }, { label: 'Вариант B' }],
};

/** Транскрипт, как его пишет CLI: вопрос задан и не отвечен. */
function transcript(at: string, entrypoint: string): string {
  const base = { sessionId: SESSION, cwd: '/w/shop', version: '2.1.295', entrypoint };
  const records = [
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: at,
      message: { role: 'user', content: 'Выбери вариант' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_vs',
            name: 'AskUserQuestion',
            input: { questions: [QUESTION] },
          },
        ],
      },
    },
  ];
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

let root: string | undefined;
let service: TelegramAnswersService | undefined;
beforeEach(() => {
  vi.stubEnv('WEB_PORT', '8888');
});
afterEach(() => {
  service?.stop();
  service = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * Сводка на настоящих частях: транскрипт → хвост → `buildInbox` → флаг `relay`,
 * как его ставит маршрут сводки, → ожидания Telegram.
 */
function setup(entrypoint: string) {
  root = mkdtempSync(join(tmpdir(), 'cc-tg-outside-'));
  const projects = join(root, 'projects');
  mkdirSync(join(projects, '-w-shop'), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(projects, '-w-shop', `${SESSION}.jsonl`),
    transcript(new Date(now - 60_000).toISOString(), entrypoint),
  );
  const tail = createTranscriptTailReader(() => projects);
  const relay = { held: false };
  const collect = async () => {
    const inbox = buildInbox({
      chats: readChats(projects),
      runs: [],
      permissions: [],
      lastAsked: (chatId) => tail(chatId)?.asked,
      clientOf: (chatId) => tail(chatId)?.client,
      now,
    });
    for (const chat of inbox.chats) {
      for (const ask of chat.asks) if (ask.kind === 'question' && relay.held) ask.relay = true;
    }
    return collectPendingAsks({
      inbox,
      defaultCli: 'Claude Code',
    });
  };
  return { collect, relay };
}

function fakeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 76;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
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
        nextId += 1;
        return ok({ message_id: nextId, chat: { id: OWNER } });
      }
      return ok(true);
    }),
  );
  return calls;
}

type Buttons = { inline_keyboard: { text: string; callback_data: string }[][] };
const buttonsOf = (body: Record<string, unknown>) =>
  ((body.reply_markup as Buttons | undefined)?.inline_keyboard ?? []).flat();

async function start(collect: () => Promise<PendingAskItem[]>) {
  const calls = fakeBot();
  const injected: InjectRequest[] = [];
  const inject: Inject = async (request) => {
    injected.push(request);
    return { statusCode: 200, body: '{}' };
  };
  const deps = { inject, runParams: () => undefined };
  const store = new AnswersStore();
  store.setSettings({ enabled: true, afterMinutes: 0, ownerId: String(OWNER), ownerName: '' });
  service = new TelegramAnswersService({
    store,
    sendGraceMs: 0,
    coalesceMs: 0,
    token: () => TOKEN,
    agentBotIds: () => new Set(),
    collect,
    apply: (target, answer, clientId) => applyAnswer(target, answer, { ...deps, clientId }),
    sendToChat: (route, text, files, clientId) =>
      sendChatText(route, text, files, { ...deps, clientId }),
    vanished: () => ({ kind: 'stale' }),
    log: () => undefined,
    scanMs: 3_600_000,
  });
  await service.restart();
  return { calls, injected };
}

describe('вопрос сессии VS Code, которую хук не держит', () => {
  it('приходит только для чтения: тот же вид, без кнопок, со строкой «Ответь в VS Code»', async () => {
    const { collect } = setup('claude-vscode');
    const { calls } = await start(collect);
    await service!.scan();
    const sent = calls.filter((call) => call.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.body.text)).toBe(
      [
        '<b>❓ ВОПРОС · 📁 shop · VS Code · Выбери вариант</b>',
        '<b>Какой вариант выбираешь?</b>',
        '',
        'Ответь в VS Code — отсюда ответ туда не дойдёт',
        '',
        OPEN,
      ].join('\n'),
    );
    expect(buttonsOf(sent[0]!.body)).toEqual([]);
  });

  it('ответ-reply на него не продолжает сессию: ничего не уходит ни в чат, ни в очередь', async () => {
    const { collect } = setup('claude-vscode');
    const { calls, injected } = await start(collect);
    await service!.scan();
    await service!.handleUpdate({
      update_id: 2,
      message: {
        message_id: 500,
        chat: { id: OWNER },
        from: { id: OWNER },
        text: 'Вариант A',
        reply_to_message: { message_id: 77 },
      },
    });
    expect(injected).toEqual([]);
    const said = calls.filter((call) => call.method === 'sendMessage').at(-1)!;
    expect(String(said.body.text)).toBe('Ответь в VS Code — отсюда ответ туда не дойдёт');
  });

  it('хук взял тот же вызов — то же сообщение получает кнопки, второго нет; ответ — хуку', async () => {
    const { collect, relay } = setup('claude-vscode');
    const { calls, injected } = await start(collect);
    await service!.scan();
    relay.held = true;
    await service!.scan();
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);
    const edit = calls.filter((call) => call.method === 'editMessageText').at(-1)!;
    expect(edit.body.message_id).toBe(77);
    expect(String(edit.body.text)).not.toContain('Ответь в VS Code');
    const buttons = buttonsOf(edit.body);
    expect(buttons.map((button) => button.text)).toEqual([
      '1. Вариант A',
      '2. Вариант B',
      '✍️ Свой ответ',
    ]);
    await service!.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb',
        from: { id: OWNER },
        data: buttons[0]!.callback_data,
        message: { message_id: 77, chat: { id: OWNER } },
      },
    });
    expect(injected).toEqual([
      {
        method: 'POST',
        url: '/api/outside/asks/toolu_vs/answer',
        payload: { answers: { 'Какой вариант выбираешь?': 'Вариант A' } },
      },
    ]);
  });

  it('свой ответ на вопрос, который держит хук, — ответом хуку на этот вызов, не сообщением в чат', async () => {
    const { collect, relay } = setup('claude-vscode');
    relay.held = true;
    const { calls, injected } = await start(collect);
    await service!.scan();
    const custom = buttonsOf(calls.find((call) => call.method === 'sendMessage')!.body).at(-1)!;
    expect(custom.text).toBe('✍️ Свой ответ');
    await service!.handleUpdate({
      update_id: 4,
      callback_query: {
        id: 'cb',
        from: { id: OWNER },
        data: custom.callback_data,
        message: { message_id: 77, chat: { id: OWNER } },
      },
    });
    // Просьба «напишите ответ» — следующее сообщение бота, 78.
    await service!.handleUpdate({
      update_id: 5,
      message: {
        message_id: 501,
        chat: { id: OWNER },
        from: { id: OWNER },
        text: 'пока ничего',
        reply_to_message: { message_id: 78 },
      },
    });
    expect(injected).toEqual([
      {
        method: 'POST',
        url: '/api/outside/asks/toolu_vs/answer',
        payload: { answers: { 'Какой вариант выбираешь?': 'пока ничего' } },
      },
    ]);
  });

  it('reply прямо на сообщение вопроса, который держит хук, — тоже ответ хуку', async () => {
    const { collect, relay } = setup('claude-vscode');
    relay.held = true;
    const { injected } = await start(collect);
    await service!.scan();
    await service!.handleUpdate({
      update_id: 6,
      message: {
        message_id: 502,
        chat: { id: OWNER },
        from: { id: OWNER },
        text: 'пока ничего',
        reply_to_message: { message_id: 77 },
      },
    });
    expect(injected.map((request) => request.url)).toEqual(['/api/outside/asks/toolu_vs/answer']);
  });

  it('хук отпустил вызов, а вопрос ещё висит — кнопки снимаются в том же сообщении', async () => {
    const { collect, relay } = setup('claude-vscode');
    relay.held = true;
    const { calls } = await start(collect);
    await service!.scan();
    expect(buttonsOf(calls.find((call) => call.method === 'sendMessage')!.body)).not.toEqual([]);
    relay.held = false;
    await service!.scan();
    const edit = calls.filter((call) => call.method === 'editMessageText').at(-1)!;
    expect(String(edit.body.text)).toContain('Ответь в VS Code — отсюда ответ туда не дойдёт');
    expect(buttonsOf(edit.body)).toEqual([]);
  });
});

describe('чья сессия — по транскрипту, а не по «идёт вне панели»', () => {
  it('терминал — «Терминал» в первой строке и «Ответь в терминале»', async () => {
    const { collect } = setup('cli');
    const [item] = await collect();
    expect(item!.target.kind).toBe('outsideQuestion');
    const text = messageText(message([sentItemOf(item!)]), [LINK]);
    expect(text.split('\n')[0]).toBe('<b>❓ ВОПРОС · 📁 shop · Терминал · Выбери вариант</b>');
    expect(text).toContain('Ответь в терминале — отсюда ответ туда не дойдёт');
  });

  it('панельный чат без хода (`sdk-cli`) — как прежде: кнопки и ответ сообщением в чат', async () => {
    const { collect } = setup('sdk-cli');
    const [item] = await collect();
    expect(item!.target).toMatchObject({ kind: 'question', chatId: SESSION });
    expect(item!.chat?.outside).toBeUndefined();
    const keyboard = keyboardOf(message([sentItemOf(item!)]), (n) => `s${n}`);
    expect(keyboard.flat().map((button) => button.text)).toContain('1. Вариант A');
  });
});

const message = (items: SentMessage['items']): SentMessage => ({
  sid: '1',
  chatId: String(OWNER),
  messageId: 1,
  nonce: 'n',
  sentAt: '2026-10-25T12:00:00.000Z',
  items,
  actions: {},
  nextAction: 0,
});

function inboxOf(over: Partial<InboxChat>, asks: InboxAsk[]): ChatInbox {
  return {
    generatedAt: '',
    chats: [
      {
        id: 's1',
        sessionId: 's1',
        title: 'Аудит проекта',
        project: 'atlas',
        projectPath: '/w/atlas',
        isSandbox: false,
        status: 'waiting',
        running: false,
        updatedAt: '2026-10-25T12:00:00Z',
        asks,
        ...over,
      },
    ],
  };
}

const ask: InboxAsk = {
  kind: 'question',
  key: 'q:t:0',
  toolUseId: 't',
  index: 0,
  total: 1,
  question: QUESTION,
  askedAt: '2026-10-25T12:00:00Z',
};
const items = (inbox: ChatInbox) => collectPendingAsks({ inbox, defaultCli: 'Claude Code' });

describe('сборка ожиданий: кому можно ответить продолжением чата', () => {
  it('клиент неизвестен и хода панели нет — только для чтения, «на компьютере»', () => {
    const [item] = items(inboxOf({}, [ask]));
    expect(item).toMatchObject({ key: 'rq:t', target: { kind: 'outsideQuestion' } });
    expect(item!.chat).toMatchObject({ outside: true, sessionId: 's1' });
    const text = messageText(message([sentItemOf(item!)]), [LINK]);
    expect(text).toContain('Ответь на компьютере — отсюда ответ туда не дойдёт');
  });

  it('идёт ход панели — вопрос её, даже если транскрипт говорит иное', () => {
    const [item] = items(inboxOf({ runKey: 'r', client: 'vscode' }, [ask]));
    expect(item!.target).toMatchObject({ kind: 'question', runKey: 'r' });
  });

  it('в сводном сообщении у вопроса только для чтения нет кнопки «Ответить»', () => {
    const [readOnly] = items(inboxOf({ client: 'vscode' }, [ask]));
    const [panel] = items(inboxOf({ id: 's2', sessionId: 's2', client: 'panel' }, [ask]));
    const keyboard = keyboardOf(
      message([sentItemOf(readOnly!), sentItemOf(panel!)]),
      (n) => `${n}`,
    );
    expect(keyboard.flat().map((button) => button.text)).toEqual(['2 · ❓ Ответить']);
  });

  it('ответ на такой вопрос маршрутом панели не уходит никуда', async () => {
    const inject = vi.fn<Inject>(async () => ({ statusCode: 200, body: '{}' }));
    const outcome = await applyAnswer(
      { kind: 'outsideQuestion', chatId: 's1', client: 'vscode' },
      { kind: 'questions', questions: [QUESTION], picks: [['Вариант A']] },
      { inject, clientId: 'c', runParams: () => undefined },
    );
    expect(outcome.ok).toBe(false);
    expect(inject).not.toHaveBeenCalled();
  });
});
