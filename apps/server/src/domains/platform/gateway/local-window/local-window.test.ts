import { describe, it, expect } from 'vitest';
import {
  ContextCutFilter,
  LOCAL_FIRST_TOKEN_FLOOR_MS,
  LOCAL_REPLY_RESERVE_TOKENS,
  PromptCounter,
  firstTokenTimeoutMs,
  maxTokensOverflowMessage,
  needsPrecount,
  overflowOfUpstream,
  promptLimitOf,
  promptTooLongMessage,
  sessionOf,
} from './local-window.ts';

describe('срок первого байта', () => {
  it('короткий промпт — пол в пять минут, а не минута облачного контура', () => {
    expect(firstTokenTimeoutMs(2_000, { context: 65_536, promptTokensPerSecond: 364 })).toBe(
      LOCAL_FIRST_TOKEN_FLOOR_MS,
    );
  });

  it('полный промпт при замеренной скорости — расчёт с запасом, выше пола', () => {
    // 130 тысяч токенов при 364 ток/с — шесть минут обработки; с запасом в полтора раза — девять.
    const ms = firstTokenTimeoutMs(130_000, { context: 131_072, promptTokensPerSecond: 364 });
    expect(ms).toBeGreaterThan(500_000);
    expect(ms).toBeLessThan(600_000);
  });

  it('замера нет — осторожная скорость, а не деление на ноль', () => {
    const ms = firstTokenTimeoutMs(130_000, { context: 131_072 });
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(LOCAL_FIRST_TOKEN_FLOOR_MS);
  });
});

describe('отказ «prompt is too long»', () => {
  it('читается регулярками Claude Code: узнавание и числа', () => {
    const text = promptTooLongMessage(134_785, promptLimitOf(131_072));
    expect(text.toLowerCase().includes('prompt is too long')).toBe(true);
    const found = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(text);
    expect([found?.[1], found?.[2]]).toEqual(['134785', '126976']);
  });
});

describe('счётчик токенов', () => {
  it('без выученного — три символа на токен; выученное держится по модели и контуру', () => {
    const counter = new PromptCounter();
    expect(counter.estimate('p', 'm', 3_000)).toBe(1_000);
    counter.learn('p', 'm', 4_000, 2_000);
    expect(counter.estimate('p', 'm', 3_000)).toBe(1_500);
    // Другая модель того же контура считается по запасной прикидке.
    expect(counter.estimate('p', 'other', 3_000)).toBe(1_000);
  });

  it('нелепое соотношение (ноль токенов, пустое тело) не портит счёт', () => {
    const counter = new PromptCounter();
    counter.learn('p', 'm', 0, 100);
    counter.learn('p', 'm', 100, 0);
    expect(counter.estimate('p', 'm', 3_000)).toBe(1_000);
    counter.learn('p', 'm', 100, 100_000);
    // Нижняя граница 1,5 символа на токен.
    expect(counter.estimate('p', 'm', 3_000)).toBe(2_000);
  });
});

describe('обрыв на пределе окна — кадры, разрезанные как угодно', () => {
  const frame = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const start = frame('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 60_000, output_tokens: 1 } },
  });
  const cutDelta = frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
    usage: { output_tokens: 5_500 },
  });
  const stop = frame('message_stop', { type: 'message_stop' });

  it('кадр делится на куски по байту — результат тот же', () => {
    const filter = new ContextCutFilter(65_536, 'ru');
    const all = start + cutDelta + stop;
    let out = '';
    for (const char of all) out += filter.push(char);
    out += filter.end();
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: error');
    expect(out).toContain('prompt is too long: 65500 tokens > 61440 maximum');
    expect(out).not.toContain('message_delta');
    expect(out).not.toContain('message_stop');
    expect(filter.cutAt).toBe(65_500);
  });

  it('предел вывода далеко от окна — кадры идут как есть', () => {
    const filter = new ContextCutFilter(65_536, 'ru');
    const small = frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 100 },
    });
    expect(filter.push(start + small + stop) + filter.end()).toBe(start + small + stop);
    expect(filter.cutAt).toBe(0);
  });

  it('вход приходит только в дельте — тоже считается', () => {
    const filter = new ContextCutFilter(8_192, 'ru');
    const delta = frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { input_tokens: 8_000, output_tokens: 190 },
    });
    expect(filter.push(delta)).toContain('event: error');
  });
});

describe('разговор запроса (sessionOf)', () => {
  const body = (user_id: unknown): unknown => ({ metadata: { user_id } });

  it('JSON-строка новых версий Claude Code (замер 14.10, 2.1.286)', () => {
    const userId = JSON.stringify({
      device_id: 'd',
      account_uuid: '',
      session_id: 'b90e523c-7bf7',
    });
    expect(sessionOf(body(userId))).toBe('b90e523c-7bf7');
  });

  it('JSON с пробелами вокруг двоеточия — тот же разговор', () => {
    const userId = JSON.stringify({ device_id: 'd', session_id: 'b90e523c-7bf7' }, null, 1);
    expect(sessionOf(body(userId))).toBe('b90e523c-7bf7');
  });

  it('прежняя запись user_<хеш>_account__session_<uuid>', () => {
    expect(sessionOf(body('user_abc123_account__session_9f8e-77'))).toBe('9f8e-77');
  });

  it('нет метки или метка чужая — нет и разговора', () => {
    expect(sessionOf({})).toBeUndefined();
    expect(sessionOf(null)).toBeUndefined();
    expect(sessionOf(body(42))).toBeUndefined();
    expect(sessionOf(body('просто строка'))).toBeUndefined();
  });
});

describe('точный счёт вместо оценки (L4b)', () => {
  const CONTEXT = 65_536;

  it('оценка далеко от окна — оценке верят, к серверу не ходим', () => {
    expect(needsPrecount(10_000, CONTEXT)).toBe(false);
  });

  it('оценка у окна (вместе с запасом под ответ больше 75%) — нужен точный счёт', () => {
    const edge = CONTEXT * 0.75 - LOCAL_REPLY_RESERVE_TOKENS;
    expect(needsPrecount(edge - 1, CONTEXT)).toBe(false);
    expect(needsPrecount(edge + 1, CONTEXT)).toBe(true);
    expect(needsPrecount(CONTEXT, CONTEXT)).toBe(true);
  });
});

describe('отказ сервера моделей «не влезает» → числа (L4b)', () => {
  it('типизированное тело llama-server: n_prompt_tokens и n_ctx', () => {
    expect(
      overflowOfUpstream(400, {
        error: { type: 'exceed_context_size_error', n_prompt_tokens: 9_001, n_ctx: 8_192 },
      }),
    ).toEqual({ tokens: 9_001, context: 8_192 });
  });

  it('только текст «request (N tokens) exceeds the available context size (M tokens)»', () => {
    expect(
      overflowOfUpstream(400, {
        error: {
          message: 'request (9001 tokens) exceeds the available context size (8192 tokens)',
        },
      }),
    ).toEqual({ tokens: 9_001, context: 8_192 });
  });

  it('не 400, не тот тип, не объект, нули в числах — это не переполнение', () => {
    const typed = { error: { type: 'exceed_context_size_error', n_prompt_tokens: 9, n_ctx: 8 } };
    expect(overflowOfUpstream(500, typed)).toBeUndefined();
    expect(overflowOfUpstream(400, 'oops')).toBeUndefined();
    expect(overflowOfUpstream(400, null)).toBeUndefined();
    expect(overflowOfUpstream(400, { error: 'x' })).toBeUndefined();
    expect(
      overflowOfUpstream(400, {
        error: { type: 'exceed_context_size_error', n_prompt_tokens: 0, n_ctx: 0 },
      }),
    ).toBeUndefined();
    expect(overflowOfUpstream(400, { error: { message: 'invalid json' } })).toBeUndefined();
  });
});

describe('вход влезает, а max_tokens — нет (L4b)', () => {
  const CONTEXT = 32_768;

  it('отказ текстом, который Claude Code разбирает сам: «вход + ответ > окно»', () => {
    const text = maxTokensOverflowMessage(10_000, 32_000, CONTEXT);
    expect(text).toBe('input length and `max_tokens` exceed context limit: 10000 + 32000 > 32768');
    // Те же числа достаёт регулярка клиента.
    const found = /context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/.exec(text ?? '');
    expect(found?.slice(1, 4)).toEqual(['10000', '32000', '32768']);
  });

  it('влезает вместе с ответом, ответа нет или он не число — без отказа', () => {
    expect(maxTokensOverflowMessage(10_000, 8_000, CONTEXT)).toBeUndefined();
    expect(maxTokensOverflowMessage(10_000, 0, CONTEXT)).toBeUndefined();
    expect(maxTokensOverflowMessage(10_000, undefined, CONTEXT)).toBeUndefined();
    expect(maxTokensOverflowMessage(10_000, '32000', CONTEXT)).toBeUndefined();
    expect(maxTokensOverflowMessage(10_000, Number.NaN, CONTEXT)).toBeUndefined();
  });

  it('вход сам не оставляет запаса под ответ — это отказ «prompt is too long», а не этот', () => {
    expect(
      maxTokensOverflowMessage(CONTEXT - LOCAL_REPLY_RESERVE_TOKENS + 1, 32_000, CONTEXT),
    ).toBeUndefined();
    expect(
      maxTokensOverflowMessage(CONTEXT - LOCAL_REPLY_RESERVE_TOKENS, 32_000, CONTEXT),
    ).toBeDefined();
  });
});
