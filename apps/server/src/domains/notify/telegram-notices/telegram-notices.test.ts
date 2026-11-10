import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramSettings } from '@agentdeck/contracts';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type {
  TelegramCommandPort,
  TelegramCoreOutcome,
} from '../telegram-core/command-port.types.ts';
import type { PendingAskItem } from '../telegram-answers/telegram-answers.types.ts';
import { createNoticeBot } from './bot.ts';
import { LABEL, TEXT, digestParts, mrButtonUrl } from './compose.ts';
import type { NoticesCore } from './core-read.ts';
import { createTelegramNotices } from './index.ts';
import { createNoticesEngine } from './notices.ts';
import { createNoticeHooks } from './press.ts';
import { NoticesStore } from './store.ts';
import type { NoticeContext, NoticePress } from './telegram-notices.types.ts';

/**
 * Уведомления о задачах ядра в боте ответов (этап 12, P191–P194): одно уведомление на конец,
 * кнопка MR только наружу, «Стоп» после конца ничего не шлёт, вариант окна — ровно `offerCommand`,
 * `/task` дважды — одна запись, «В работу» — через запускатель, тихие часы со сводкой, 429 без
 * потерь. Подделаны только границы: Bot API (`fetch`), чтение ядра и порт команд ядра.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';
const T1 = '01900000-0000-7000-8000-000000000001';
const T2 = '01900000-0000-7000-8000-000000000002';
const T3 = '01900000-0000-7000-8000-000000000003';
const U1 = '01900000-0000-7000-8000-0000000000a1';
const E1 = '01900000-0000-7000-8000-0000000000e1';
const E2 = '01900000-0000-7000-8000-0000000000e2';
const ctx: NoticeContext = {
  token: TOKEN,
  origin: { apiBase: 'https://api.telegram.org', botId: '123456789', chatId: OWNER, fromId: OWNER },
};

type Call = { method: string; body: Record<string, unknown>; messageId?: number };
type Button = { text: string; callback_data?: string; url?: string };

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const tooMany = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 1',
      parameters: { retry_after: 1 },
    }),
    { status: 429 },
  );
const refused = () =>
  new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), {
    status: 400,
  });

/** Bot API: каждый вызов записан; `plan` — разовые ответы по порядку вызовов. */
function fakeTelegram() {
  const calls: Call[] = [];
  const plan: (() => Response)[] = [];
  let nextId = 700;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      const call: Call = { method, body };
      calls.push(call);
      const once = plan.shift();
      if (once) return once();
      if (method === 'sendMessage') {
        nextId += 1;
        call.messageId = nextId;
        return ok({ message_id: nextId, chat: { id: Number(body.chat_id) } });
      }
      return ok(true);
    }),
  );
  const sends = () => calls.filter((one) => one.method === 'sendMessage' && one.messageId);
  return { calls, plan, sends };
}

const keyboardOf = (call: Call): Button[][] =>
  ((call.body.reply_markup as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ??
    []) as Button[][];

/** Нажатие кнопки с меткой `text` под отправленным сообщением, как его пришлёт Telegram. */
function pressOf(call: Call, text: string, over: Partial<{ messageId: number }> = {}): NoticePress {
  const button = keyboardOf(call)
    .flat()
    .find((one) => one.text === text);
  if (!button?.callback_data) throw new Error(`no button ${text}`);
  const reply = (call.body.reply_parameters as { message_id?: number } | undefined)?.message_id;
  return {
    id: `press-${text}`,
    from: { id: Number(OWNER) },
    data: button.callback_data,
    message: {
      message_id: over.messageId ?? call.messageId!,
      chat: { id: Number(OWNER) },
      reply_markup: call.body.reply_markup,
      // Telegram кладёт в нажатие, на что ответило сообщение бота (у `/task` — сам `/task`).
      ...(reply === undefined ? {} : { reply_to_message: { message_id: reply } }),
    },
  } as unknown as NoticePress;
}

const viewOf = (taskId: string, over: Partial<TaskView> = {}): TaskView =>
  ({
    taskId,
    seq: 1,
    state: 'running',
    ended: null,
    steps: [],
    asks: [],
    mrs: [],
    windowWait: null,
    ...over,
  }) as unknown as TaskView;

const itemOf = (view: TaskView, title: string | null = 'Починить вход'): TaskListItem => ({
  taskId: view.taskId,
  live: view.ended === null,
  seq: view.seq,
  state: view.state,
  ended: view.ended,
  title,
  attention: null,
});

const window = (seq: number, offers: string[]) =>
  ({
    stepId: null,
    routeId: 'claude',
    verdict: 'exhausted',
    resetAt: null,
    alternatives: [],
    skipped: [],
    offers,
    seq,
  }) as unknown as TaskView['windowWait'];

function fakeCore() {
  const views = new Map<string, TaskView>();
  const titles = new Map<string, string | null>();
  let entries: BoardEntry[] = [];
  const core: NoticesCore = {
    tasks: async () => [...views.values()].map((view) => itemOf(view, titles.get(view.taskId))),
    view: async (taskId) => {
      const view = views.get(taskId);
      if (!view) throw new Error(`GET /v1/tasks/${taskId}: 404`);
      return view;
    },
    entries: async () => entries,
  };
  return {
    core,
    put: (view: TaskView, title: string | null = 'Починить вход') => {
      views.set(view.taskId, view);
      titles.set(view.taskId, title);
    },
    setEntries: (next: Partial<BoardEntry>[]) => {
      entries = next as BoardEntry[];
    },
  };
}

type PortCall = { method: keyof TelegramCommandPort; input: Record<string, unknown> };

function fakePort() {
  const calls: PortCall[] = [];
  const replies: TelegramCoreOutcome[] = [];
  const answer = (): TelegramCoreOutcome => replies.shift() ?? { ok: true, status: 200, body: {} };
  const port: TelegramCommandPort = {
    command: async (_origin, input) => {
      calls.push({ method: 'command', input: input as unknown as Record<string, unknown> });
      return answer();
    },
    inboxCreate: async (_origin, input) => {
      calls.push({ method: 'inboxCreate', input });
      return answer();
    },
    boardWork: async (_origin, input) => {
      calls.push({ method: 'boardWork', input });
      return answer();
    },
  };
  return { port, calls, replies };
}

const DAY = new Date(2026, 10, 9, 14, 0).getTime();
const NIGHT = new Date(2026, 10, 9, 2, 0).getTime();
const MORNING = new Date(2026, 10, 9, 9, 0).getTime();
const QUIET = { from: '23:00', to: '08:00', asks: false };

const dirs: string[] = [];
function world(options: { dir?: string; settings?: Partial<TelegramSettings>; now?: number } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tg-notices-'));
  if (!options.dir) dirs.push(dir);
  const clock = { now: options.now ?? DAY };
  const settings: TelegramSettings = {
    enabled: true,
    chatId: OWNER,
    events: ['runError', 'testFailed'],
    doneAfterMinutes: 5,
    ...options.settings,
  };
  const core = fakeCore();
  const port = fakePort();
  const store = new NoticesStore(dir, () => undefined);
  let minted = 0;
  const mintId = () => `cmd-${++minted}`;
  const bot = createNoticeBot({ sleep: async () => undefined });
  const log = vi.fn();
  const engine = createNoticesEngine({
    store,
    core: core.core,
    port: port.port,
    bot,
    token: () => TOKEN,
    ownerId: () => OWNER,
    settings: () => settings,
    covers: () => true,
    now: () => clock.now,
    log,
    mintId,
    pumpMs: 0,
    debounceMs: 0,
  });
  const hooks = createNoticeHooks({
    store,
    core: core.core,
    port: port.port,
    bot,
    engine,
    now: () => clock.now,
    mintId,
  });
  return { dir, clock, settings, core, port, store, engine, hooks, log };
}

beforeEach(() => {
  vi.stubEnv('WEB_PORT', '8888');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('конец задачи и MR — одно уведомление, ссылка только наружу', () => {
  it('готова с открытым MR — одно сообщение: кнопка-ссылка MR и «На доработку»; второй проход молчит', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        ended: 'done',
        mrs: [
          {
            unitId: U1,
            url: 'https://tracker.example.com/group/app/-/merge_requests/7',
            iid: 7,
            title: 'Fix login',
            state: 'opened',
          },
        ],
      }),
    );
    await w.engine.evaluate(T1);
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(1);
    const sent = tg.sends()[0]!;
    expect(String(sent.body.text)).toContain('✅ Задача готова');
    expect(String(sent.body.text)).toContain('!7');
    expect(keyboardOf(sent)).toEqual([
      [{ text: LABEL.mr, url: 'https://tracker.example.com/group/app/-/merge_requests/7' }],
      [{ text: LABEL.rework, callback_data: expect.stringMatching(/^n:/) }],
    ]);
    expect(w.store.wasSent(`mr:${T1}:${U1}`)).toBe(true);
  });

  it('«На доработку» законченной задачи — носитель с тем же MR: второго «MR открыт» нет, его конец — одно уведомление', async () => {
    const tg = fakeTelegram();
    const w = world();
    const url = 'https://tracker.example.com/group/app/-/merge_requests/4';
    const U2 = '01900000-0000-7000-8000-0000000000a2';
    w.core.put(viewOf(T1, { ended: 'done', mrs: [{ unitId: U1, url, iid: 4, state: 'opened' }] }));
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(1);
    // Носитель доработки (`openAnswerTask`) пишет тот же MR своей нулевой единице ещё в оценке.
    w.core.put(
      viewOf(T2, { state: 'estimating', mrs: [{ unitId: U2, url, iid: 4, state: 'opened' }] }),
    );
    await w.engine.evaluate(T2);
    w.core.put(
      viewOf(T2, { state: 'publishing', mrs: [{ unitId: U2, url, iid: 4, state: 'opened' }] }),
    );
    await w.engine.evaluate(T2);
    expect(tg.sends()).toHaveLength(1);
    expect(tg.sends().some((one) => String(one.body.text).includes('🔀 MR открыт'))).toBe(false);
    w.core.put(viewOf(T2, { ended: 'done', mrs: [{ unitId: U2, url, iid: 4, state: 'opened' }] }));
    await w.engine.evaluate(T2);
    expect(tg.sends()).toHaveLength(2);
    expect(String(tg.sends()[1]!.body.text)).toContain('✅ Задача готова');
  });

  it('адрес MR на loopback или http — без кнопки-ссылки, строкой в тексте', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        ended: 'done',
        mrs: [
          {
            unitId: U1,
            url: 'https://127.0.0.1:8929/g/a/-/merge_requests/3',
            iid: 3,
            state: 'opened',
          },
        ],
      }),
    );
    await w.engine.evaluate(T1);
    const sent = tg.sends()[0]!;
    expect(
      keyboardOf(sent)
        .flat()
        .some((one) => one.url),
    ).toBe(false);
    expect(String(sent.body.text)).toContain('127.0.0.1:8929');
    for (const url of [
      'http://tracker.example.com/mr/1',
      'https://localhost/mr/1',
      'https://[::1]/mr/1',
      'https://app.localhost/mr/1',
      'https://0.0.0.0/mr/1',
      'не адрес',
    ]) {
      expect(mrButtonUrl(url), url).toBeUndefined();
    }
    expect(mrButtonUrl('https://tracker.example.com/mr/1')).toBe(
      'https://tracker.example.com/mr/1',
    );
  });

  it('MR открыт, пока задача идёт, — «На доработку» и «Стоп»; застанный слитым — молча закрыт', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        state: 'publishing',
        mrs: [
          { unitId: U1, url: 'https://tracker.example.com/mr/1', iid: 1, state: 'opened' },
          {
            unitId: '01900000-0000-7000-8000-0000000000a2',
            url: 'https://tracker.example.com/mr/2',
            iid: 2,
            state: 'merged',
          },
        ],
      }),
    );
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(1);
    expect(String(tg.sends()[0]!.body.text)).toContain('🔀 MR открыт');
    expect(keyboardOf(tg.sends()[0]!)[1]!.map((one) => one.text)).toEqual([
      LABEL.rework,
      LABEL.stop,
    ]);
  });

  it('порог «Закончил» 0 — о конце молчит; падение — только с подпиской runError, с причиной шага', async () => {
    const tg = fakeTelegram();
    const w = world({ settings: { doneAfterMinutes: 0, events: [] } });
    w.core.put(viewOf(T1, { ended: 'done' }));
    w.core.put(
      viewOf(T2, {
        ended: 'failed',
        steps: [
          { outcome: 'failed', reason: 'check `lint` failed' },
        ] as unknown as TaskView['steps'],
      }),
    );
    await w.engine.evaluate(T1);
    await w.engine.evaluate(T2);
    expect(tg.sends()).toHaveLength(0);
    expect(w.store.wasSent(`done:${T1}`)).toBe(true);
    expect(w.store.wasSent(`failed:${T2}`)).toBe(true);

    const on = world({ settings: { events: ['runError'] } });
    on.core.put(
      viewOf(T2, {
        ended: 'failed',
        steps: [{ outcome: 'failed', reason: 'check lint failed' }] as unknown as TaskView['steps'],
      }),
    );
    await on.engine.evaluate(T2);
    expect(tg.sends()).toHaveLength(1);
    expect(String(tg.sends()[0]!.body.text)).toContain('check lint failed');
  });

  it('первый проход без недавнего прошлого — вчерашние концы не сообщаются; новый конец после — да', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(viewOf(T1, { ended: 'done' }));
    await w.engine.pump(DAY);
    expect(tg.sends()).toHaveLength(0);
    w.core.put(viewOf(T2, { ended: 'done' }));
    await w.engine.pump(DAY + 6_000);
    expect(tg.sends()).toHaveLength(1);
    expect(String(tg.sends()[0]!.body.text)).toContain('Починить вход');
  });
});

describe('кнопки уведомления — нажатие честное, команда через порт', () => {
  it('«Стоп» после конца задачи не шлёт ничего: правка «Уже закончена» и тост', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        state: 'publishing',
        mrs: [{ unitId: U1, url: 'https://tracker.example.com/mr/1', iid: 1, state: 'opened' }],
      }),
    );
    await w.engine.evaluate(T1);
    w.core.put(viewOf(T1, { ended: 'cancelled', state: 'publishing' }));
    await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.stop));
    expect(w.port.calls).toEqual([]);
    const edit = tg.calls.find((one) => one.method === 'editMessageText')!;
    expect(String(edit.body.text)).toContain('Уже закончена');
    const toast = tg.calls.find((one) => one.method === 'answerCallbackQuery')!;
    expect(toast.body.text).toBe('Уже закончена');
  });

  it('«Стоп» живой задачи — отмена с ключом повтора; ядро не ответило — тот же ключ, отказ — новый', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        state: 'publishing',
        mrs: [{ unitId: U1, url: 'https://tracker.example.com/mr/1', iid: 1, state: 'opened' }],
      }),
    );
    await w.engine.evaluate(T1);
    const press = pressOf(tg.sends()[0]!, LABEL.stop);
    w.port.replies.push({ ok: false, status: 0, code: 'unreachable', message: 'down' });
    await w.hooks.press(ctx, press);
    w.port.replies.push({
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'no',
      reason: 'owner not bound',
    });
    await w.hooks.press(ctx, press);
    await w.hooks.press(ctx, press);
    const ids = w.port.calls.map((one) => one.input.cmdId);
    expect(ids).toEqual(['cmd-1', 'cmd-1', 'cmd-2']);
    expect(w.port.calls[0]!.input).toMatchObject({ kind: 'cancel', taskId: T1 });
    const refusal = tg.sends().find((one) => String(one.body.text).includes('owner not bound'))!;
    expect(String(refusal.body.text)).toContain('Привязка бота к ядру');
    // Принято — кнопки сняты: следующее нажатие устарело, команды нет.
    await w.hooks.press(ctx, press);
    expect(w.port.calls).toHaveLength(3);
  });

  it('подменённая метка, чужое сообщение, чужая подпись — «Кнопка устарела», команды нет', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        state: 'publishing',
        mrs: [{ unitId: U1, url: 'https://tracker.example.com/mr/1', iid: 1, state: 'opened' }],
      }),
    );
    await w.engine.evaluate(T1);
    const sent = tg.sends()[0]!;
    const forged = pressOf(sent, LABEL.stop);
    const markup = structuredClone(sent.body.reply_markup) as { inline_keyboard: Button[][] };
    markup.inline_keyboard[1]![1]!.text = '✅ Одобрить';
    (forged.message as unknown as { reply_markup: unknown }).reply_markup = markup;
    await w.hooks.press(ctx, forged);
    await w.hooks.press(ctx, pressOf(sent, LABEL.stop, { messageId: 1 }));
    const tampered = pressOf(sent, LABEL.stop);
    await w.hooks.press(ctx, { ...tampered, data: `${tampered.data!.slice(0, -2)}xx` });
    expect(w.port.calls).toEqual([]);
    const toasts = tg.calls.filter((one) => one.method === 'answerCallbackQuery');
    expect(toasts.map((one) => one.body.text)).toEqual([
      'Кнопка устарела',
      'Кнопка устарела',
      'Кнопка устарела',
    ]);
  });

  it('«На доработку» — подсказка с ответом; ответ на неё — доработка, ответ на само уведомление — подсказка', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(viewOf(T1, { ended: 'done' }));
    await w.engine.evaluate(T1);
    const notice = tg.sends()[0]!;
    await w.hooks.press(ctx, pressOf(notice, LABEL.rework));
    const prompt = tg.sends()[1]!;
    expect(prompt.body.reply_markup).toMatchObject({ force_reply: true });
    const reply = (id: number, text: string) =>
      [{ message_id: id, chat: { id: Number(OWNER) }, text }] as never;
    expect(await w.hooks.reply(ctx, reply(900, 'добавь тест'), prompt.messageId!)).toBe(true);
    expect(w.port.calls).toEqual([
      {
        method: 'command',
        input: { kind: 'rework', taskId: T1, fields: { text: 'добавь тест' }, cmdId: 'cmd-1' },
      },
    ]);
    // Отказ по существу (не полномочия) — словами ядра, без подсказки о привязке.
    w.port.replies.push({
      ok: false,
      status: 409,
      code: 'rework-refused',
      message: 'no remote',
      reason: 'remotes: no origin',
    });
    expect(await w.hooks.reply(ctx, reply(903, 'ещё раз'), prompt.messageId!)).toBe(true);
    const refusal = String(tg.sends().at(-1)!.body.text);
    expect(refusal).toContain('Ядро отказало: remotes: no origin.');
    expect(refusal).not.toContain('Привязка');
    expect(await w.hooks.reply(ctx, reply(901, 'и ещё'), notice.messageId!)).toBe(true);
    expect(w.port.calls).toHaveLength(2);
    expect(String(tg.sends().at(-1)!.body.text)).toContain('Ответ на уведомление не уходит');
    expect(await w.hooks.reply(ctx, reply(902, 'мимо'), 12345)).toBe(false);
  });
});

describe('карточка окна — варианты перевода', () => {
  const offers = ['cli:codex', 'model:gpt-5'];

  it('карточка: «Стоп» и вариант на строку; клик по модели — ровно offerCommand, без усилия', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(viewOf(T1, { state: 'waiting-window', windowWait: window(3, offers) }));
    await w.engine.evaluate(T1);
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(1);
    const card = tg.sends()[0]!;
    const rows = keyboardOf(card).map((row) => row.map((one) => one.text));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual([LABEL.stop]);
    await w.hooks.press(ctx, pressOf(card, rows[2]![0]!));
    expect(w.port.calls).toEqual([
      {
        method: 'command',
        input: {
          kind: 'set-model',
          taskId: T1,
          fields: { scope: 'task', scopeId: T1, timing: 'now', model: 'gpt-5', effort: null },
          cmdId: 'cmd-1',
        },
      },
    ]);
  });

  it('клик по CLI — set-cli; варианты сменились — команды нет, «Варианты окна сменились»', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(viewOf(T1, { state: 'waiting-window', windowWait: window(3, offers) }));
    await w.engine.evaluate(T1);
    const card = tg.sends()[0]!;
    const cli = keyboardOf(card)[1]![0]!.text;
    w.core.put(viewOf(T1, { state: 'waiting-window', windowWait: window(4, ['model:gpt-5']) }));
    await w.hooks.press(ctx, pressOf(card, cli));
    expect(w.port.calls).toEqual([]);
    expect(tg.calls.find((one) => one.method === 'answerCallbackQuery')!.body.text).toBe(
      'Варианты окна сменились — откройте задачу в панели',
    );

    const again = world();
    again.core.put(viewOf(T2, { state: 'waiting-window', windowWait: window(1, offers) }));
    await again.engine.evaluate(T2);
    await again.hooks.press(ctx, pressOf(tg.sends().at(-1)!, cli));
    expect(again.port.calls[0]!.input).toMatchObject({
      kind: 'set-cli',
      fields: { adapter: 'codex', scope: 'task', timing: 'now' },
    });
  });

  it('вопрос исчерпания держит варианты — карточки нет', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(
      viewOf(T1, {
        state: 'waiting-window',
        windowWait: window(3, offers),
        asks: [
          { state: 'open', dedupe: 'exhausted:claude', stepId: null },
        ] as unknown as TaskView['asks'],
      }),
    );
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(0);
  });
});

describe('/task и «В работу»', () => {
  const taskMessage = (id: number, text: string) =>
    ({ message_id: id, chat: { id: Number(OWNER) }, text }) as never;
  /** Запись `/task` на доске ядра: с репозиториями из `telegram.repos` — запускаемая. */
  const entryOf = (repos: boolean | 'empty', msg = 0): Partial<BoardEntry> => ({
    entryId: E1,
    state: 'inbox',
    source: { kind: 'telegram', key: `tg:${OWNER}:${msg}`, title: 't' },
    launch: {
      kind: 'fields',
      fields: {
        title: 't',
        request: 't',
        ...(repos === 'empty' ? { repos: [] } : {}),
        ...(repos === true ? { repos: [{ path: 'C:/work/app', baseRef: null }] } : {}),
      },
    } as BoardEntry['launch'],
  });
  /** Мир, где запись `/task` уже запускаемая (репозитории заданы в карточке). */
  const launchableWorld = (msg = 0) => {
    const w = world();
    w.core.setEntries([entryOf(true, msg)]);
    return w;
  };

  it('то же сообщение дважды — одна запись и один ответ; пустое — подсказка', async () => {
    const tg = fakeTelegram();
    const w = launchableWorld(50);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    expect(await w.hooks.command(ctx, taskMessage(50, '/task исправить вход'))).toBe(true);
    expect(await w.hooks.command(ctx, taskMessage(50, '/task исправить вход'))).toBe(true);
    expect(w.port.calls).toEqual([
      {
        method: 'inboxCreate',
        input: { cmdId: 'cmd-1', text: 'исправить вход', key: `tg:${OWNER}:50` },
      },
    ]);
    expect(tg.sends()).toHaveLength(1);
    expect(String(tg.sends()[0]!.body.text)).toContain('Во «Входящих»: исправить вход');
    expect(keyboardOf(tg.sends()[0]!)[0]![0]!.text).toBe(LABEL.work);
    expect(await w.hooks.command(ctx, taskMessage(51, '/task'))).toBe(true);
    expect(String(tg.sends().at(-1)!.body.text)).toContain('Напишите так: /task');
    expect(await w.hooks.command(ctx, taskMessage(52, '/status'))).toBe(false);
  });

  it('«В работу» — ход доски через запускатель: в очереди, затем «Запущена» по записям доски', async () => {
    const tg = fakeTelegram();
    const w = launchableWorld(60);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(60, '/task собрать отчёт'));
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { entries: [{ entryId: E1, state: 'queued' }] },
    });
    await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.work));
    expect(w.port.calls[1]).toEqual({
      method: 'boardWork',
      input: { cmdId: 'cmd-2', entryId: E1 },
    });
    expect(
      String(tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!.body.text),
    ).toContain('В очереди');
    w.core.put(viewOf(T3), 'Собрать отчёт');
    w.core.setEntries([{ entryId: E1, state: 'started', taskId: T3 } as Partial<BoardEntry>]);
    w.store.file_.lastPumpAt = DAY;
    await w.engine.pump(DAY + 6_000);
    expect(
      String(tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!.body.text),
    ).toContain('▶️ Запущена — «Собрать отчёт»');
    expect(w.store.file_.watch).toEqual([]);
  });

  it('запускатель вернул с причиной — причина под сообщением, кнопка жива и шлёт новый ключ', async () => {
    const tg = fakeTelegram();
    const w = launchableWorld(70);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(70, '/task прогнать тесты'));
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { entries: [{ entryId: E1, state: 'inbox', reason: 'no free slot' }] },
    });
    const press = pressOf(tg.sends()[0]!, LABEL.work);
    await w.hooks.press(ctx, press);
    const edit = tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!;
    // Незнакомая причина ядра — общая русская строка и ссылка на доску, не английская проза.
    expect(String(edit.body.text)).toContain('Не запущена — причина на доске');
    expect(String(edit.body.text)).toContain('/core?view=board">Открыть доску →</a>');
    expect(String(edit.body.text)).not.toContain('no free slot');
    expect(
      keyboardOf(edit)
        .flat()
        .map((one) => one.text),
    ).toContain(LABEL.work);
    await w.hooks.press(ctx, press);
    expect(w.port.calls.slice(1).map((one) => one.input.cmdId)).toEqual(['cmd-2', 'cmd-3']);
  });

  it.each([
    ['поля нет', false],
    ['пустой список', 'empty'],
  ] as const)(
    'запись без репозиториев (%s) — «В работу» нет: подсказка, где их задать, и ссылка на доску (W2-D F2)',
    async (_case, repos) => {
      const tg = fakeTelegram();
      const w = world();
      w.core.setEntries([entryOf(repos, 80)]);
      w.port.replies.push({
        ok: true,
        status: 200,
        body: { created: [E1], existing: [], replayed: false },
      });
      await w.hooks.command(ctx, taskMessage(80, '/task поправить меню'));
      const sent = tg.sends()[0]!;
      expect(String(sent.body.text)).toContain('Во «Входящих»: поправить меню');
      expect(String(sent.body.text)).toContain('Репозитории для задач из Telegram');
      expect(String(sent.body.text)).toContain('/core?view=board">Открыть доску →</a>');
      expect(keyboardOf(sent).flat()).toEqual([]);
    },
  );

  it('доска ядра не прочиталась — кнопки нет (не запускаемо, пока не доказано обратное)', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.core.entries = async () => {
      throw new Error('GET /v1/board: 503');
    };
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(81, '/task поправить меню'));
    expect(keyboardOf(tg.sends()[0]!).flat()).toEqual([]);
  });

  it.each([
    [
      'launch fields: fields.repos expected array, received undefined',
      'не задан репозиторий',
      'launch fields',
    ],
    ['route window holds the start: claude: exhausted', 'окно маршрута закрыто', 'route window'],
    ['the conductor is not running in this core', 'ядро сейчас не запускает задачи', 'conductor'],
    [
      'C:/work/app: not a git repository',
      'не git-репозиторий: проверьте «Репозитории для задач из Telegram»',
      'C:/work/app',
    ],
    [
      'C:/work/app: base main not found; C:/work/lib: base dev not found',
      'такой ветки в репозитории нет',
      'not found',
    ],
  ])(
    'отказ запускателя «%s» — по-русски («%s»), без английской прозы',
    async (reason, russian, english) => {
      const tg = fakeTelegram();
      const w = launchableWorld(90);
      w.port.replies.push({
        ok: true,
        status: 200,
        body: { created: [E1], existing: [], replayed: false },
      });
      await w.hooks.command(ctx, taskMessage(90, '/task собрать'));
      w.port.replies.push({
        ok: true,
        status: 200,
        body: { entries: [{ entryId: E1, state: 'inbox', reason }] },
      });
      await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.work));
      const edit = tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!;
      expect(String(edit.body.text)).toContain(russian);
      expect(String(edit.body.text)).not.toContain(english);
    },
  );

  it('отказ хода с кодом и английской причиной (409 move-not-allowed) — русская строка, не причина ядра', async () => {
    const tg = fakeTelegram();
    const w = launchableWorld(95);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(95, '/task собрать'));
    w.port.replies.push({
      ok: false,
      status: 409,
      code: 'move-not-allowed',
      message: 'Ход доски не разрешён',
      reason: `move work is not allowed for entry ${E1} in queued`,
    });
    await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.work));
    const texts = [
      ...tg.calls.filter((one) => one.method === 'editMessageText'),
      ...tg.sends().slice(1),
    ].map((one) => String(one.body.text));
    expect(texts.join('\n')).toContain('«В работу» этой записи сейчас недоступно');
    expect(texts.join('\n')).not.toContain('is not allowed');
    // Под отказом — ссылка на доску: там ядро показывает причину целиком.
    expect(texts.join('\n')).toContain('/core?view=board">Открыть доску →</a>');
  });

  /** Две записи `/task` на доске (сообщения 61 и 62), уведомление о первой — с кнопкой. */
  const twoEntries = async () => {
    const tg = fakeTelegram();
    const w = world();
    const second = { ...entryOf(true, 62), entryId: E2 };
    w.core.setEntries([entryOf(true, 61), second]);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(61, '/task первая'));
    const sent = tg.sends()[0]!;
    return { tg, w, sent, second };
  };

  it('файл уведомлений переписан на чужую запись — «В работу» запускает запись нажатого /task', async () => {
    const { w, sent } = await twoEntries();
    // Правка файла: сообщение о первой записи теперь «указывает» на вторую.
    const message = w.store.messageById(sent.messageId!)!;
    message.entryId = E2;
    await w.hooks.press(ctx, pressOf(sent, LABEL.work));
    expect(w.port.calls.filter((one) => one.method === 'boardWork')).toEqual([
      { method: 'boardWork', input: { cmdId: 'cmd-2', entryId: E1 } },
    ]);
  });

  it.each([
    ['нажатие не несёт /task, на который ответило', 'no-reply', 'записи больше нет на доске'],
    ['записи с ключом нажатого /task на доске нет', 'gone', 'записи больше нет на доске'],
    ['запись с этим ключом не из Telegram', 'foreign', 'записи больше нет на доске'],
    ['запись перестала быть запускаемой', 'no-repos', 'не задан репозиторий'],
    ['доска ядра не прочиталась', 'unreadable', 'доска ядра не прочиталась'],
  ] as const)(
    '«В работу»: %s — отказ русской строкой, ни одного хода доски',
    async (_case, kind, russian) => {
      const { tg, w, sent, second } = await twoEntries();
      let press = pressOf(sent, LABEL.work);
      if (kind === 'no-reply') {
        press = { ...press, message: { ...press.message!, reply_to_message: undefined } };
      }
      if (kind === 'gone') w.core.setEntries([second]);
      if (kind === 'foreign') {
        w.core.setEntries([
          { ...entryOf(true, 61), source: { kind: 'tracker', key: `tg:${OWNER}:61`, title: 't' } },
        ]);
      }
      if (kind === 'no-repos') w.core.setEntries([entryOf(false, 61), second]);
      if (kind === 'unreadable') {
        w.core.core.entries = async () => {
          throw new Error('GET /v1/board: 503');
        };
      }
      await w.hooks.press(ctx, press);
      expect(w.port.calls.filter((one) => one.method === 'boardWork')).toEqual([]);
      const edit = tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!;
      expect(String(edit.body.text)).toContain(russian);
      expect(String(edit.body.text)).toContain('/core?view=board">Открыть доску →</a>');
      expect(tg.calls.filter((one) => one.method === 'answerCallbackQuery').at(-1)!.body.text).toBe(
        TEXT.refusedToast,
      );
    },
  );

  it.each([401, 403])(
    '«В работу» отбит полномочиями (%i) — «не признан ядром» и подсказка привязки, без прозы ядра',
    async (status) => {
      const tg = fakeTelegram();
      const w = launchableWorld(96);
      w.port.replies.push({
        ok: true,
        status: 200,
        body: { created: [E1], existing: [], replayed: false },
      });
      await w.hooks.command(ctx, taskMessage(96, '/task собрать'));
      w.port.replies.push({
        ok: false,
        status,
        code: 'telegram-binding',
        message: 'no',
        reason: 'telegram owner is not bound',
      });
      await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.work));
      const texts = tg
        .sends()
        .slice(1)
        .map((one) => String(one.body.text))
        .join('\n');
      expect(texts).toContain('ход из Telegram не признан ядром');
      expect(texts).toContain('Привязка бота к ядру');
      expect(texts).not.toContain('is not bound');
    },
  );

  it('вернулась во «Входящие» после очереди (обход записей) — причина по-русски', async () => {
    const tg = fakeTelegram();
    const w = launchableWorld(96);
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { created: [E1], existing: [], replayed: false },
    });
    await w.hooks.command(ctx, taskMessage(96, '/task собрать'));
    w.port.replies.push({
      ok: true,
      status: 200,
      body: { entries: [{ entryId: E1, state: 'queued' }] },
    });
    await w.hooks.press(ctx, pressOf(tg.sends()[0]!, LABEL.work));
    w.core.setEntries([
      { ...entryOf(true, 96), reason: 'no start proof: queue it by hand or enable auto-queue' },
    ]);
    w.store.file_.lastPumpAt = DAY;
    await w.engine.pump(DAY + 6_000);
    const text = String(
      tg.calls.filter((one) => one.method === 'editMessageText').at(-1)!.body.text,
    );
    expect(text).toContain('запись не поставлена в очередь человеком');
    expect(text).not.toContain('no start proof');
  });
});

describe('тихие часы и сводка', () => {
  it('ночью конец задачи ложится в сводку; утром — одна сводка, после перезапуска второй раз не приходит', async () => {
    const tg = fakeTelegram();
    const w = world({ settings: { quiet: QUIET }, now: NIGHT });
    w.core.put(viewOf(T1, { ended: 'done' }), 'Ночная задача');
    w.store.file_.lastPumpAt = NIGHT;
    await w.engine.pump(NIGHT + 6_000);
    await w.engine.evaluate(T1);
    expect(tg.sends()).toHaveLength(0);
    expect(w.store.file_.held.map((one) => one.line)).toEqual(['✅ готова — «Ночная задача»']);

    // Перезапуск панели: новая запись с диска, тот же каталог.
    const after = world({ dir: w.dir, settings: { quiet: QUIET }, now: MORNING });
    after.core.put(viewOf(T1, { ended: 'done' }), 'Ночная задача');
    await after.engine.pump(MORNING);
    await after.engine.pump(MORNING + 6_000);
    expect(tg.sends()).toHaveLength(1);
    expect(String(tg.sends()[0]!.body.text)).toBe(
      '<b>🌙 Пока было тихо (1):</b>\n✅ готова — «Ночная задача»',
    );
    const again = world({ dir: w.dir, settings: { quiet: QUIET }, now: MORNING + 60_000 });
    again.core.put(viewOf(T1, { ended: 'done' }), 'Ночная задача');
    await again.engine.pump(MORNING + 60_000);
    expect(tg.sends()).toHaveLength(1);
  });

  it('удержанная карточка окна — утром заново, если окно то же; сменилось — не приходит', async () => {
    const tg = fakeTelegram();
    const w = world({ settings: { quiet: QUIET }, now: NIGHT });
    w.core.put(viewOf(T1, { state: 'waiting-window', windowWait: window(3, ['model:gpt-5']) }));
    w.core.put(viewOf(T2, { state: 'waiting-window', windowWait: window(5, ['cli:codex']) }));
    await w.engine.evaluate(T1);
    await w.engine.evaluate(T2);
    expect(w.store.file_.held).toHaveLength(2);
    w.clock.now = MORNING;
    w.core.put(viewOf(T2, { state: 'waiting-window', windowWait: window(6, ['cli:codex']) }));
    w.store.file_.lastPumpAt = MORNING;
    await w.engine.pump(MORNING + 1);
    const cards = tg.sends().filter((one) => String(one.body.text).includes('⏳'));
    expect(cards).toHaveLength(2);
    // T1 — та же карточка по удержанному ключу; T2 — новый шаг окна, новой карточкой прохода.
    expect(w.store.wasSent(`window:${T1}:3`)).toBe(true);
    expect(w.store.wasSent(`window:${T2}:6`)).toBe(true);
    expect(w.store.file_.held).toEqual([]);
  });

  it('длинная сводка режется по пределу; часть не ушла — повтор шлёт только остаток', async () => {
    const tg = fakeTelegram();
    const w = world({ settings: { quiet: QUIET }, now: MORNING });
    const title = 'Задача с длинным названием '.repeat(4);
    w.store.file_.held = Array.from({ length: 80 }, (_, i) => ({
      key: `done:t${i}`,
      kind: 'done' as const,
      taskId: `t${i}`,
      line: `✅ готова — «${title}${i}»`,
      at: NIGHT,
    }));
    const parts = digestParts(w.store.file_.held.map((one) => one.line));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((sum, part) => sum + part.count, 0)).toBe(80);
    w.store.file_.lastPumpAt = MORNING;
    tg.plan.push(() => ok({ message_id: 1, chat: { id: 1 } }), refused);
    await w.engine.pump(MORNING + 1);
    expect(w.store.file_.held).toHaveLength(80 - parts[0]!.count);
    await w.engine.pump(MORNING + 10_000);
    expect(w.store.file_.held).toEqual([]);
    const calls = tg.calls.filter((one) => one.method === 'sendMessage');
    expect(calls[0]!.body.text).toBe(parts[0]!.text);
    // Отказанная вторая часть не в счёт: каждая строка в принятых частях — ровно один раз.
    const delivered = calls
      .filter((_, i) => i !== 1)
      .flatMap((one) => String(one.body.text).split('\n'));
    for (const item of Array.from({ length: 80 }, (_, i) => `«${title}${i}»`)) {
      expect(
        delivered.filter((line) => line.endsWith(item)),
        item,
      ).toHaveLength(1);
    }
  });

  it('вопрос без действия по умолчанию проходит тишину без «asks»; с ним — держится; «asks» — держит все', () => {
    const blocking = { key: 'a' } as PendingAskItem;
    const soft = { key: 'b', defaultAction: 'deny' } as unknown as PendingAskItem;
    const off = world({ settings: { quiet: QUIET } });
    expect(off.engine.hold([blocking, soft], DAY)).toEqual([blocking, soft]);
    expect(off.engine.hold([blocking, soft], NIGHT)).toEqual([blocking]);
    const strict = world({ settings: { quiet: { ...QUIET, asks: true } } });
    expect(strict.engine.hold([blocking, soft], NIGHT)).toEqual([]);
  });
});

describe('429 и порядок', () => {
  it('всплеск 429 — каждое уведомление уходит, по порядку, ни одно не потеряно', async () => {
    const tg = fakeTelegram();
    const w = world();
    for (const [id, title] of [
      [T1, 'Первая'],
      [T2, 'Вторая'],
      [T3, 'Третья'],
    ] as const) {
      w.core.put(viewOf(id, { ended: 'done' }), title);
    }
    w.store.file_.lastPumpAt = DAY;
    // Первое — два 429 подряд, второе — один: повторы по retry_after, очередь чата не обгоняет.
    tg.plan.push(tooMany, tooMany);
    const sending = w.engine.pump(DAY + 1);
    await vi.waitFor(() => expect(tg.calls.length).toBeGreaterThanOrEqual(3));
    tg.plan.push(tooMany);
    await sending;
    await w.engine.pump(DAY + 6_000);
    const titles = tg.sends().map((one) => /«(.+?)»/.exec(String(one.body.text))?.[1]);
    expect(titles).toEqual(['Первая', 'Вторая', 'Третья']);
    expect(w.store.seenEnded(T1) && w.store.seenEnded(T2) && w.store.seenEnded(T3)).toBe(true);
  });

  it('три 429 подряд — уведомление не потеряно: ключ свободен, следующий проход шлёт его один раз', async () => {
    const tg = fakeTelegram();
    const w = world();
    w.core.put(viewOf(T1, { ended: 'done' }), 'Первая');
    w.store.file_.lastPumpAt = DAY;
    tg.plan.push(tooMany, tooMany, tooMany);
    await w.engine.pump(DAY + 1);
    expect(tg.sends()).toHaveLength(0);
    expect(w.store.wasSent(`done:${T1}`)).toBe(false);
    await w.engine.pump(DAY + 6_000);
    await w.engine.pump(DAY + 12_000);
    expect(tg.sends()).toHaveLength(1);
    expect(w.store.wasSent(`done:${T1}`)).toBe(true);
  });
});

describe('createTelegramNotices — сборка', () => {
  it('сверка ответов запускает проход: конец задачи уходит; опрос ответов не жив — тишина; строки /status', async () => {
    const tg = fakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'tg-notices-'));
    dirs.push(dir);
    const core = fakeCore();
    core.put(viewOf(T1, { state: 'running' }), 'Живая');
    let covers = false;
    const notices = createTelegramNotices({
      coreHome: () => dir,
      appData: () => dir,
      log: () => undefined,
      token: () => TOKEN,
      ownerId: () => OWNER,
      settings: () => ({ enabled: true, chatId: OWNER, events: [] }),
      covers: () => covers,
      core: core.core,
      port: fakePort().port,
      delivery: { sleep: async () => undefined },
      pumpMs: 0,
    });
    core.put(viewOf(T1, { ended: 'done' }), 'Живая');
    // Опрос ответов не жив — кнопки некому разбирать: ни прохода, ни уведомления.
    notices.hold([], Date.now());
    notices.onLine({ taskId: T1, title: 'Живая' }, { event: 'task.ended' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tg.calls).toEqual([]);
    covers = true;
    notices.onLine({ taskId: T1, title: 'Живая' }, { event: 'task.ended' });
    await vi.waitFor(() => expect(tg.sends()).toHaveLength(1), { timeout: 3_000 });
    expect(String(tg.sends()[0]!.body.text)).toContain('«Живая»');
    core.put(viewOf(T2, { state: 'running' }), 'Вторая');
    expect(await notices.statusLines()).toEqual([
      '',
      '<b>🧠 Задачи ядра: 1</b>',
      '• «Вторая» — в работе',
    ]);
    notices.stop();
  });
});
