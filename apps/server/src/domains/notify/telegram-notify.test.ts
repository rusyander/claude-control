import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramLastSend, TelegramSettings } from '@agentdeck/contracts';
import type { RunNotice } from './run-notice.types.ts';
import { compose, createTelegramNotifier, type TelegramNotice } from './telegram.ts';
import {
  deliverTelegram,
  LAST_SEND_FILE,
  readLastSend,
  writeLastSend,
} from './telegram-delivery.ts';
import {
  composeRich,
  errorClassOf,
  firstQuestionOf,
  isContinuationTitle,
  withoutPaths,
} from './telegram-text.ts';

/**
 * Уведомления Telegram 25.10: три строки (событие и проект, имя чата, суть),
 * молчание о правах и вопросах, пока их доставляют ответы с кнопками, один
 * повтор на 429 и обрыв сети, итог последней отправки на карточке.
 */

const BOT = '7654321:AAH-SUPER-SECRET-TOKEN-VALUE';
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const settings = (events: TelegramSettings['events']): TelegramSettings => ({
  enabled: true,
  chatId: '4242',
  events,
});

/** Ответы Bot API по очереди; последний повторяется. */
function stubSend(replies: (Response | Error)[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (reply instanceof Error) throw reply;
      return reply.clone();
    }),
  );
  return bodies;
}

const okReply = () => new Response('{"ok":true,"result":{}}', { status: 200 });
const tooMany = (seconds: number) =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${seconds}`,
      parameters: { retry_after: seconds },
    }),
    { status: 429 },
  );

beforeEach(() => {
  vi.stubEnv('WEB_PORT', '8888');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('текст Telegram о прогоне', () => {
  it('право: «Агент ждёт вас · проект · сессия» жирным, «Нужно разрешение:» второй строкой; без чата ссылки нет', () => {
    expect(
      composeRich(
        { kind: 'permission', projectPath: '/Users/me/work/shop', toolName: 'Bash' },
        'Починить вход',
      ),
    ).toBe('<b>⏳ Агент ждёт вас · 📁 shop · Починить вход</b>\n<b>Нужно разрешение:</b> Bash');
  });

  it('вопрос: под маской, пути свёрнуты; текст один раз, длинный — 300 и «…полностью в панели»', () => {
    const question = `Куда положить ключ ${SECRET} в /Users/me/work/shop/src/config/app.ts?`;
    const text = composeRich({ kind: 'question', projectPath: 'C:/work/shop', question }, 'Чат')!;
    expect(text.split('\n')).toEqual([
      '<b>⏳ Агент ждёт вас · 📁 shop · Чат</b>',
      '<b>Нужно решить:</b> Куда положить ключ •••••• в …/app.ts?',
    ]);
    expect(text).not.toContain('sk-ant-api03-AAAA');
    expect(text).not.toContain('/Users/me');
    const long = composeRich({ kind: 'question', question: 'а'.repeat(500) })!;
    expect(long.split('\n')).toEqual([
      '<b>⏳ Агент ждёт вас</b>',
      `<b>Нужно решить:</b> ${'а'.repeat(300)}…полностью в панели`,
    ]);
  });

  it('имя сессии обрезается до 40, тесты — «N из M упали», ошибка — только класс', () => {
    const title = composeRich({ kind: 'question', projectPath: '/w/shop' }, 'б'.repeat(120))!;
    expect(title.split('\n')[0]).toBe(`<b>⏳ Агент ждёт вас · 📁 shop · ${'б'.repeat(39)}…</b>`);
    expect(composeRich({ kind: 'testFailed', failed: 3, total: 10 })).toBe(
      '<b>🧪 ТЕСТЫ</b>\n<b>3 из 10 упали</b>',
    );
    expect(
      composeRich({
        kind: 'error',
        projectPath: '/w/shop',
        errorText: 'TypeError: Cannot read properties of undefined at /Users/me/shop/src/a.ts:10',
      }),
    ).toBe(
      '<b>🛑 ОШИБКА · 📁 shop</b>\n<b>Агент упал</b>\n<blockquote expandable>TypeError</blockquote>',
    );
    expect(composeRich({ kind: 'error', errorText: 'что-то пошло не так в /etc/x/y' })).toBe(
      '<b>🛑 ОШИБКА</b>\n<b>Агент упал</b>',
    );
  });

  it('класс ошибки и свёртка путей', () => {
    expect(errorClassOf('spawn claude ENOENT')).toBe('ENOENT');
    expect(errorClassOf('{"type":"overloaded_error"}')).toBe('overloaded_error');
    expect(errorClassOf('API Error: 529 {"message":"x"}')).toBe('HTTP 529');
    expect(errorClassOf(undefined)).toBeUndefined();
    expect(withoutPaths('см. C:\\work\\shop\\a.ts и ~/x/y.md, а и/или нет')).toBe(
      'см. …/a.ts и …/y.md, а и/или нет',
    );
  });

  it('имя-продолжение («продолжай по … .md») в первую строку не идёт; обычное имя идёт', () => {
    expect(isContinuationTitle('Продолжение по .agent/notes.md')).toBe(true);
    expect(isContinuationTitle('continue from docs/plan.md')).toBe(true);
    expect(isContinuationTitle('Прогресс по PROGRESS')).toBe(true);
    expect(isContinuationTitle('Продолжение по .mdx-шаблону')).toBe(false);
    expect(isContinuationTitle('Починить вход')).toBe(false);
    const closed = (title: string) =>
      composeRich(
        {
          kind: 'done',
          chatId: 's1',
          projectPath: '/w/shop',
          durationMs: 6 * 60_000,
          turn: { kind: 'closed', summary: 'Вход починен.' },
        },
        title,
      )?.split('\n')[0];
    expect(closed('Продолжение по .agent/notes.md')).not.toContain('Продолжение');
    expect(closed('Починить вход')).toContain('Починить вход');
  });

  it('вопрос берётся из входа AskUserQuestion; бюджет и сигнал сторожа — без своего текста', () => {
    expect(firstQuestionOf({ questions: [{ question: ' Какой порт? ' }, { question: 'b' }] })).toBe(
      'Какой порт?',
    );
    expect(firstQuestionOf({})).toBeUndefined();
    expect(composeRich({ kind: 'budgetNear' })).toBeUndefined();
  });
});

describe('createTelegramNotifier: текст, молчание, повтор, итог', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const notice: TelegramNotice = {
    kind: 'question',
    chatId: 'run-1',
    projectPath: '/Users/me/work/shop',
    question: 'Какой адрес оставить?',
  };

  it('в Telegram уходят три строки с именем чата; вебхуку остаётся прежняя строка', async () => {
    const bodies = stubSend([okReply()]);
    const results: TelegramLastSend[] = [];
    createTelegramNotifier({
      settings: () => settings(['question']),
      token: () => BOT,
      titleOf: (chatId) => (chatId === 'run-1' ? 'Починить вход' : undefined),
      onResult: (result) => results.push(result),
      now: () => Date.parse('2026-10-25T10:00:00Z'),
    })(notice);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(bodies[0]!.text).toBe(
      '<b>⏳ Агент ждёт вас · 📁 shop · Починить вход</b>\n' +
        '<b>Нужно решить:</b> Какой адрес оставить?\n\n' +
        '<a href="http://127.0.0.1:8888/chat?id=run-1">Открыть чат →</a>',
    );
    expect(results[0]).toEqual({ at: '2026-10-25T10:00:00.000Z', ok: true });
    expect(compose(notice)).toBe('❓ Агент задал вопрос — shop');
  });

  it('ответы из Telegram живы — права и вопросы молчат, конец прогона уходит', async () => {
    const bodies = stubSend([okReply()]);
    const notify = createTelegramNotifier({
      settings: () => settings(['permission', 'question', 'runDone']),
      token: () => BOT,
      answersCover: () => true,
      schedule: (run) => run(),
    });
    notify(notice);
    notify({ kind: 'permission', chatId: 'run-1', toolName: 'Bash' });
    notify({
      kind: 'done',
      chatId: 'run-1',
      durationMs: 10 * 60_000,
      answer: 'Задача закрыта: вход снова работает.',
    });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodies).toHaveLength(1);
    expect(String(bodies[0]!.text)).toContain('✅ Задача закрыта');
  });

  it('429 — ждёт retry_after до 120 с и повторяет; просит дольше — отказ без ожидания', async () => {
    stubSend([tooMany(7), tooMany(90), okReply()]);
    const sleep = vi.fn(async () => undefined);
    expect(await deliverTelegram(BOT, '1', 'x', { sleep })).toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[7_000], [90_000]]);
    stubSend([tooMany(300)]);
    const longer = vi.fn(async () => undefined);
    const result = await deliverTelegram(BOT, '1', 'x', { sleep: longer });
    expect(longer).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: '429: Too Many Requests: retry after 300' });
  });

  it('429 — очередь своего чата: следующая отправка туда не обгоняет ждущую', async () => {
    const bodies = stubSend([tooMany(5), okReply(), okReply()]);
    let release: () => void = () => undefined;
    const sleep = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const first = deliverTelegram(BOT, '1', 'первое', { sleep });
    const second = deliverTelegram(BOT, '1', 'второе', { sleep });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    expect(bodies.map((body) => body.text)).toEqual(['первое']);
    release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(bodies.map((body) => body.text)).toEqual(['первое', 'первое', 'второе']);
  });

  it('обрыв сети — повтор через 2 с; 400, 401, 403 — без повтора', async () => {
    const bodies = stubSend([new TypeError('fetch failed'), okReply()]);
    const sleep = vi.fn(async () => undefined);
    expect(await deliverTelegram(BOT, '1', 'x', { sleep })).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(bodies).toHaveLength(2);
    for (const status of [400, 401, 403]) {
      const calls = stubSend([
        new Response(JSON.stringify({ ok: false, error_code: status, description: 'nope' }), {
          status,
        }),
      ]);
      const never = vi.fn(async () => undefined);
      expect(await deliverTelegram(BOT, '1', 'x', { sleep: never })).toEqual({
        ok: false,
        error: `${status}: nope`,
      });
      expect(never).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });

  it('итог отказа ложится на диск без токена и текста; битый файл — ничего', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tg-last-'));
    const appData = dir;
    stubSend([
      new Response(
        JSON.stringify({ ok: false, error_code: 403, description: `bot${BOT} was blocked` }),
        { status: 403 },
      ),
    ]);
    const errors: unknown[] = [];
    createTelegramNotifier({
      settings: () => settings(['question']),
      token: () => BOT,
      onResult: (result) => writeLastSend(appData, result),
      onError: (error) => errors.push(error),
    })(notice);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    const raw = readFileSync(join(appData, LAST_SEND_FILE), 'utf8');
    expect(raw).not.toContain('SUPER-SECRET');
    expect(raw).not.toContain('Какой адрес');
    expect(readLastSend(appData)).toMatchObject({
      ok: false,
      error: '403: bot<токен> was blocked',
    });
    writeFileSync(join(appData, LAST_SEND_FILE), '{"ok":');
    expect(readLastSend(appData)).toBeUndefined();
  });
});

describe('Конец хода — «Задача закрыта» или «Агент ждёт вас», только после долгой работы', () => {
  const CLOSED = 'Задача закрыта. Вход снова работает: токен обновляется сам, тесты зелёные.';
  const done = (minutes: number, over: Partial<RunNotice> = {}): RunNotice => ({
    kind: 'done',
    chatId: 'run-1',
    projectPath: '/w/shop',
    durationMs: minutes * 60_000,
    answer: CLOSED,
    ...over,
  });
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
  const notifier = (
    doneAfterMinutes: number | undefined,
    over: Partial<Parameters<typeof createTelegramNotifier>[0]> = {},
    events: TelegramSettings['events'] = ['runError'],
  ) =>
    createTelegramNotifier({
      settings: () => ({
        enabled: true,
        chatId: '4242',
        events,
        ...(doneAfterMinutes === undefined ? {} : { doneAfterMinutes }),
      }),
      token: () => BOT,
      titleOf: () => 'Починить вход',
      schedule: (run) => run(),
      ...over,
    });

  it('задача закрыта, дольше порога — вид, проект, сессия, одна-две фразы итога, «шёл N мин»; галочка runDone не нужна', async () => {
    const bodies = stubSend([okReply()]);
    notifier(5)(done(12));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.text).toBe(
      '<b>✅ Задача закрыта · 📁 shop · Починить вход</b>\n' +
        'Вход снова работает: токен обновляется сам, тесты зелёные.\nшёл 12 мин\n\n' +
        '<a href="http://127.0.0.1:8888/chat?id=run-1">Открыть чат →</a>',
    );
  });

  it('ответ спрашивает — «Агент ждёт вас», «Нужно решить:» и варианты из перечня под вопросом', async () => {
    const bodies = stubSend([okReply()]);
    notifier(5)(
      done(42, {
        answer:
          'Ревью готово, 4 замечания.\n\nОпубликовать замечания тредами в MR?\n\n1. Да, все\n2. Только серьёзные',
      }),
    );
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(String(bodies[0]!.text).split('\n').slice(0, 5)).toEqual([
      '<b>⏳ Агент ждёт вас · 📁 shop · Починить вход</b>',
      '<b>Нужно решить:</b> Опубликовать замечания тредами в MR?',
      '1. Да, все',
      '2. Только серьёзные',
      'шёл 42 мин',
    ]);
  });

  it('промежуточная остановка — тишина: шаг внутри задачи, фон, пробуждение, работа ушла дальше, звено группы', async () => {
    const bodies = stubSend([okReply()]);
    notifier(5)(done(30, { answer: 'Зона API закрыта. Дальше делаю зону веба.' }));
    notifier(5)(done(30, { answer: 'Гейт ещё идёт, итог пришлю после него.' }));
    notifier(5)(done(30, { background: true, answer: 'Жду агентов B и C.' }));
    notifier(5)(done(30, { wakeup: true }));
    notifier(5)(done(30, { continued: true }));
    notifier(5)(done(30, { interrupted: true }));
    notifier(5)(done(30, { answer: '' }));
    notifier(5, { subtask: () => true })(done(30));
    notifier(5, { busy: () => true })(done(30));
    await quiet();
    expect(bodies).toHaveLength(0);
  });

  it('прогон панели судится через 20 с: за это время чат снова занят — тишина, свободен — карточка', async () => {
    const bodies = stubSend([okReply()]);
    const queued: { run: () => void; ms: number }[] = [];
    let busy = false;
    const notify = notifier(5, {
      schedule: (run, ms) => queued.push({ run, ms }),
      busy: () => busy,
    });
    notify(done(12, { turnKey: 'a' }));
    notify(done(12, { turnKey: 'b' }));
    expect(queued.map((entry) => entry.ms)).toEqual([20_000, 20_000]);
    busy = true;
    queued[0]!.run();
    busy = false;
    queued[1]!.run();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    await quiet();
    expect(bodies).toHaveLength(1);
  });

  it('сессия вне панели судится сразу (своё ожидание она выждала), справка о чате упала — судит уведомление', async () => {
    const bodies = stubSend([okReply()]);
    const queued: (() => void)[] = [];
    notifier(5, {
      schedule: (run) => queued.push(run),
      busy: () => {
        throw new Error('нет справки');
      },
    })(done(12, { outside: true }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(queued).toHaveLength(0);
  });

  it('висящий вопрос инструментом: ушёл своим «вопросом» — повтора нет; не подписан — «ждёт» его словами и вариантами', async () => {
    const bodies = stubSend([okReply()]);
    const asked = done(20, {
      answer: 'Нужно выбрать порт.',
      asked: true,
      question: 'Какой порт оставить?',
      options: ['3000', '8080'],
    });
    notifier(5, {}, ['question'])(asked);
    notifier(5, { answersCover: () => true })(asked);
    await quiet();
    expect(bodies).toHaveLength(0);
    notifier(5)(asked);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(String(bodies[0]!.text).split('\n').slice(1, 4)).toEqual([
      '<b>Нужно решить:</b> Какой порт оставить?',
      '1. 3000',
      '2. 8080',
    ]);
  });

  it('один ход — одна карточка его вида: повтор того же конца молчит, новый ход — снова', async () => {
    const bodies = stubSend([okReply()]);
    const notify = notifier(5);
    notify(done(12, { turnKey: '100' }));
    notify(done(12, { turnKey: '100' }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    await quiet();
    expect(bodies).toHaveLength(1);
    notify(done(12, { turnKey: '200' }));
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
  });

  it('короче порога, порог 0 — тишина; без настройки порог 5 минут', async () => {
    const bodies = stubSend([okReply()]);
    notifier(5)(done(3));
    notifier(0)(done(60));
    notifier(undefined)(done(4));
    await quiet();
    expect(bodies).toHaveLength(0);
    notifier(undefined)(done(6));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
  });

  it('без длительности (прогон не сказал, сколько шёл) — тишина', async () => {
    const bodies = stubSend([okReply()]);
    notifier(5)({ kind: 'done', chatId: 'run-1', answer: CLOSED });
    await quiet();
    expect(bodies).toHaveLength(0);
  });
});
