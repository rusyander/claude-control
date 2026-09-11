import { describe, it, expect, vi } from 'vitest';
import type { Platform } from '@agentdeck/contracts';
import {
  callUpstream,
  retryPauseMs,
  upstreamUrl,
  UpstreamError,
  UPSTREAM_RETRY_PAUSE_MS,
  type UpstreamCall,
} from './upstream.ts';

/**
 * Поход в контур: адрес, ключ и единственная повторная попытка (план §3).
 *
 * Повтор проверяется с двух сторон сразу — что он есть там, где отказ временный
 * и на стороне контура, и что его НЕТ там, где второй такой же запрос стоил бы
 * человеку второго списания.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  caCertPath: '',
};

const call = (
  responses: (Response | Error)[],
  extra: Partial<UpstreamCall> = {},
): { run: () => Promise<Response>; fetchImpl: ReturnType<typeof vi.fn> } => {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('лишний запрос в контур');
    return next;
  });
  return {
    fetchImpl,
    run: () =>
      callUpstream({
        platform: PLATFORM,
        token: 'platform-token-9f2b',
        path: 'chat/completions',
        body: '{}',
        fetchImpl,
        ...extra,
      }),
  };
};

describe('ключ, не пролезающий в заголовок', () => {
  it('назван ключом, а не «нет связи» — на пути шлюза, а не только пробы', async () => {
    // Подмены здесь нет намеренно: ошибку рождает САМ транспорт, складывая
    // заголовок из символа выше 255. Запрос идёт настоящим `fetch` на заведомо
    // мёртвый порт — до сети дело не доходит, ключ отваливается раньше. Ключи,
    // сохранённые до Т12, ещё существуют, поэтому исходящий путь обязан назвать
    // причину сам, а не полагаться на проверку при сохранении.
    await expect(
      callUpstream({
        platform: { ...PLATFORM, baseUrl: 'http://127.0.0.1:1' },
        token: 'platform-token-ключ',
        path: 'chat/completions',
        body: '{}',
        retry: false,
      }),
    ).rejects.toThrow(/Ключ контура не годится для заголовка/);
  });
});

describe('нужна ли вторая попытка', () => {
  const at = (status: number, headers: Record<string, string> = {}): Response =>
    new Response(null, { status, headers });

  it('повторяем только временное и только на стороне контура', () => {
    expect(retryPauseMs(at(429))).toBe(UPSTREAM_RETRY_PAUSE_MS);
    expect(retryPauseMs(at(500))).toBe(UPSTREAM_RETRY_PAUSE_MS);
    expect(retryPauseMs(at(503))).toBe(UPSTREAM_RETRY_PAUSE_MS);

    expect(retryPauseMs(at(200))).toBeNull();
    expect(retryPauseMs(at(400))).toBeNull();
    // 451 — решение проверок содержимого, а не сбой: повтор дал бы тот же отказ.
    expect(retryPauseMs(at(451))).toBeNull();
    expect(retryPauseMs(at(402))).toBeNull();
  });

  it('названную контуром паузу уважаем — но не любую', () => {
    expect(retryPauseMs(at(429, { 'retry-after': '1' }))).toBe(1_000);
    expect(retryPauseMs(at(429, { 'retry-after': '0' }))).toBe(0);
    // Полминуты молчания клиент читает как «панель зависла»: отдаём ему отказ.
    expect(retryPauseMs(at(429, { 'retry-after': '30' }))).toBeNull();
    // Форма даты законна не меньше секунд — и считается ТОЧНО, а не «в пределах
    // потолка»: умолчание (700 мс) уложилось бы в потолок тоже, и проверка
    // ничего бы не доказывала.
    const soon = new Date(1_700_000_001_000).toUTCString();
    expect(retryPauseMs(at(503, { 'retry-after': soon }), 1_700_000_000_000)).toBe(1_000);
    // Отрицательные секунды — «уже можно», а не пауза назад.
    expect(retryPauseMs(at(503, { 'retry-after': '-5' }))).toBe(0);
    // Заголовки — байты: непонятное значение не должно ронять поход в контур.
    expect(retryPauseMs(at(503, { 'retry-after': 'soon-ish' }))).toBe(UPSTREAM_RETRY_PAUSE_MS);
    // Дата в прошлом — «уже можно», а не отрицательная пауза.
    const past = new Date(1_699_999_000_000).toUTCString();
    expect(retryPauseMs(at(503, { 'retry-after': past }), 1_700_000_000_000)).toBe(0);
  });
});

describe('повтор в бою', () => {
  it('503 переживается одной повторной попыткой', async () => {
    const { run, fetchImpl } = call([
      new Response('перезапуск', { status: 503, headers: { 'retry-after': '0' } }),
      new Response('data: ok\n\n', { status: 200 }),
    ]);
    const response = await run();
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Адрес у обеих попыток один и тот же — уйти на другой шлюз нельзя ни разу.
    for (const [url] of fetchImpl.mock.calls) {
      expect(url).toBe(upstreamUrl(PLATFORM, 'chat/completions'));
    }
  });

  it('вторая неудача отдаётся как есть, третьей попытки нет', async () => {
    const { run, fetchImpl } = call([
      new Response(null, { status: 500, headers: { 'retry-after': '0' } }),
      new Response(null, { status: 500, headers: { 'retry-after': '0' } }),
    ]);
    expect((await run()).status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('отказ по существу не повторяется', async () => {
    const { run, fetchImpl } = call([new Response(null, { status: 451 })]);
    expect((await run()).status).toBe(451);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('обрыв связи не повторяется: запрос мог дойти и списать расход', async () => {
    const { run, fetchImpl } = call([new Error('socket hang up')]);
    await expect(run()).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('повтор выключается явно — для тех, кому нужен один выстрел', async () => {
    const { run, fetchImpl } = call([new Response(null, { status: 503 })], { retry: false });
    expect((await run()).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('перенаправление контура — отказ с названным адресом, а не второй адрес', async () => {
    const { run, fetchImpl } = call([
      new Response('', { status: 307, headers: { location: 'https://other.example.com/v1/chat' } }),
    ]);
    // Один-единственный поход: за `Location` шлюз не идёт ни при каких условиях —
    // туда уехал бы весь промпт, а клиент увидел бы обычный 200.
    await expect(run()).rejects.toThrow(/перенаправлением на https:\/\/other\.example\.com/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('перенаправление без Location всё равно отказ', async () => {
    const { run } = call([new Response('', { status: 302 })]);
    await expect(run()).rejects.toBeInstanceOf(UpstreamError);
  });

  it('мост отмены живёт весь ответ, а не до заголовков', async () => {
    // Клиент уходит ПОСЛЕ заголовков — самый частый случай: человек нажал
    // Ctrl-C, пока модель отвечает. Если мост снят, контур продолжает говорить
    // и списывать расход в никуда.
    const controller = new AbortController();
    const { run, fetchImpl } = call([new Response('data: ok\n\n', { status: 200 })], {
      signal: controller.signal,
    });
    await run();
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const upstreamSignal = (init as { signal: AbortSignal }).signal;
    expect(upstreamSignal.aborted).toBe(false);
    controller.abort(new Error('клиент ушёл'));
    expect(upstreamSignal.aborted).toBe(true);
  });

  it('ушедший клиент не ждёт паузы и не получает второй попытки вслепую', async () => {
    const controller = new AbortController();
    const { run, fetchImpl } = call(
      [
        new Response(null, { status: 503, headers: { 'retry-after': '2' } }),
        new Response(null, { status: 200 }),
      ],
      { signal: controller.signal },
    );
    const pending = run();
    controller.abort(new Error('клиент ушёл'));
    await pending;
    // Пауза прервана сигналом — иначе тест ждал бы две секунды.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1] ?? [];
    expect((init as { signal: AbortSignal } | undefined)?.signal.aborted).toBe(true);
  });
});
