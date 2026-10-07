import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Отказ аналитики под CLI без своих журналов (SF-4) глазами телефона. Подменены
 * только сокет (`fetch`) и хранилище подключения; разбор ответа, перевод кода
 * настоящим словарём телефона и правило повтора — настоящие. Тело ответа — та же
 * форма, что шлёт `analytics-routes.ts`.
 */

vi.mock('../../shared/api/connection', () => ({
  currentConnection: () => ({ url: 'http://panel', token: 'phone-token' }),
  isConfigured: () => true,
}));
vi.mock('../../shared/config/i18n', async () => {
  const { en } = await import('../../shared/config/i18n/en');
  return { dict: () => en };
});

const { analyticsQueryOptions, analyticsRefusal, DEFAULT_PERIOD } = await import('./api');

const answer = (status: number, body: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
};

const refusalBody = {
  error: 'provider_unsupported',
  message:
    'Аналитика читает журналы только Claude Code, Codex и Qwen Code, а активный CLI — Goose.',
  messageCode: 'analytics-provider-unsupported',
  params: { provider: 'Goose' },
};

async function failureOf(options: ReturnType<typeof analyticsQueryOptions>): Promise<Error> {
  try {
    await options.queryFn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('запрос не упал');
}

describe('аналитика под CLI без своих журналов', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('409 панели становится отказом с именем CLI на языке телефона', async () => {
    answer(409, refusalBody);
    const error = await failureOf(analyticsQueryOptions(DEFAULT_PERIOD, 'goose'));

    const text = analyticsRefusal(error);
    expect(text).toContain('Goose');
    expect(text).toMatch(/^Analytics reads the logs of Claude Code, Codex and Qwen Code only/);
  });

  it('отказ не повторяется, обычный сбой — повторяется один раз', async () => {
    const options = analyticsQueryOptions(DEFAULT_PERIOD, 'goose');
    answer(409, refusalBody);
    const refused = await failureOf(options);
    answer(500, { message: 'boom' });
    const broken = await failureOf(options);

    expect(options.retry(0, refused)).toBe(false);
    expect(options.retry(0, broken)).toBe(true);
    expect(options.retry(1, broken)).toBe(false);
    expect(analyticsRefusal(broken)).toBeUndefined();
  });

  it('чужой 409 (другой код) отказом аналитики не считается', async () => {
    answer(409, { error: 'conflict', message: 'занято' });
    expect(analyticsRefusal(await failureOf(analyticsQueryOptions(DEFAULT_PERIOD, 'goose')))).toBe(
      undefined,
    );
  });

  it('активный CLI входит в ключ кэша: отчёт Claude не доживает под goose', () => {
    const claude = analyticsQueryOptions(DEFAULT_PERIOD, 'claude').queryKey;
    const goose = analyticsQueryOptions(DEFAULT_PERIOD, 'goose').queryKey;
    expect(claude).not.toEqual(goose);
  });
});
