import type { Platform } from '@agentdeck/contracts';
import { createCaStreamFetch, type PlatformFetch } from '../ca-fetch.ts';
import { headerUnsafeKeyReason } from '../errors.ts';
import { contourHeaders, contourUrl } from '../transport.ts';

/**
 * Поход в контур: единственное место шлюза, где ключ попадает в запрос.
 *
 * Три правила, заданные жёстко:
 *
 * 1. Адрес собирается ТОЛЬКО из настройки контура. Никакого запасного адреса,
 *    никакого «попробуем облако вендора» и ни одного перенаправления: контур
 *    недоступен — это отказ (`mode: 'required'`), ответ 3xx — тоже отказ, с
 *    названным адресом (`assertNoRedirect`), потому что увести корпоративный
 *    запрос на чужой адрес молча хуже любого отказа.
 * 2. Ключ уходит одним заголовком, который даёт драйвер, и больше никуда: ни в
 *    адрес, ни в тело, ни в след запроса, ни в лог.
 * 3. Ответ отдаётся ПОТОКОМ. Собранное тело убило бы весь смысл: первые токены
 *    видны до конца ответа, и ради этого шлюз и переводит не-потоковые вызовы
 *    в потоковые (`nonstream-120s`). Потолок ответа платформы поток НЕ снимает
 *    (у платформы компании 120 с режут и его, `responseCeilingSec`) — он лишь даёт клиенту
 *    видеть ответ, пока тот идёт. Исключение объявляет драйвер
 *    (`DriverControl.streamless`): тело, с которым контур поток отвергает
 *    (платформа компании: `single_turn`), идёт целиком, а клиенту поток собирается из
 *    готового ответа.
 */

/** Сколько ждём ЗАГОЛОВКОВ ответа. Дальше поток может идти сколько угодно. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;

/**
 * Сколько ждём цельного ответа, когда драйвер предела не объявил: его заголовки
 * приезжают вместе с готовым текстом, и потоковые 60 с оборвали бы законный
 * длинный ход. Потолок панели, а не число какой-то платформы.
 */
export const UPSTREAM_WHOLE_BODY_TIMEOUT_MS = 125_000;

/** Запас на дорогу сверх объявленного предела: сдаться должен контур, а не мы. */
const WHOLE_BODY_MARGIN_MS = 5_000;

/** Ожидание цельного ответа у платформы с таким манифестом. */
export function wholeBodyTimeoutMs(driver: { nonStreamTimeoutSec?: number }): number {
  const declared = driver.nonStreamTimeoutSec;
  if (declared === undefined || !Number.isFinite(declared) || declared <= 0) {
    return UPSTREAM_WHOLE_BODY_TIMEOUT_MS;
  }
  return Math.round(declared * 1_000) + WHOLE_BODY_MARGIN_MS;
}

/** Запас до объявленного потолка: обрыв за пять секунд до него — уже он. */
const CEILING_SLACK_MS = 5_000;

/**
 * Причина обрыва, если он пришёлся на потолок ответа платформы
 * (`responseCeilingSec`). `undefined` — потолок не объявлен или до него далеко:
 * называть потолком обрыв на тридцатой секунде значило бы соврать о причине.
 */
export function ceilingCutMessage(
  driver: { responseCeilingSec?: number },
  elapsedMs: number,
): string | undefined {
  const ceiling = driver.responseCeilingSec;
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return undefined;
  if (elapsedMs < ceiling * 1_000 - CEILING_SLACK_MS) return undefined;
  return (
    `Ответ контура оборвался на ${ceiling}-й секунде — это потолок самой платформы на любой ` +
    'ответ, поток тоже. Сеть здесь ни при чём: сократите ход (меньше размышлений, короче ' +
    'ответ) или попросите владельца контура поднять потолок'
  );
}

/** Пауза перед единственной повторной попыткой, когда контур сам её не назвал. */
export const UPSTREAM_RETRY_PAUSE_MS = 700;

/**
 * Дольше этого не ждём: клиент шлюза стоит на линии, и молчание в минуту он
 * читает как «панель зависла». Названная контуром пауза сверх потолка означает
 * не «подожди», а «сегодня не твой день» — такой ответ отдаём клиенту как есть.
 */
export const UPSTREAM_RETRY_MAX_PAUSE_MS = 2_000;

export interface UpstreamCall {
  platform: Platform;
  token: string;
  /** Путь внутри версии API: `chat/completions`, `models`. */
  path: string;
  method?: string;
  body?: string;
  /** Клиент отвалился — прекращаем и наверху. */
  signal?: AbortSignal;
  /** Выключает единственную повторную попытку; по умолчанию она есть. */
  retry?: boolean;
  /**
   * Что готовы принять. По умолчанию поток: через этот вызов идёт чат, а он
   * потоковый всегда. Не-потоковым ручкам (агенты, эмбеддинги) поток не
   * предлагают — контур на него отвечает четырёхсотым.
   */
  accept?: string;
  /**
   * Свой потолок ожидания ЗАГОЛОВКОВ. По умолчанию годится для потока, где
   * заголовки приходят сразу, а тело идёт сколько угодно. У не-потоковой ручки
   * заголовки приезжают вместе с готовым ответом, в конце работы, и общий
   * потолок оборвал бы законный длинный прогон — уже оплаченный.
   */
  headersTimeoutMs?: number;
  /**
   * Заголовки протокола (`anthropic-version`). Лежат ПОД заголовками контура:
   * ни ключ, ни настроенные человеком заголовки ими не перебиваются.
   */
  headers?: Readonly<Record<string, string>>;
  /** Подстановка для тестов; по умолчанию — свой транспорт с корнем компании. */
  fetchImpl?: PlatformFetch;
}

/** Не дошли до контура. Причина уже пригодна для показа человеку. */
export class UpstreamError extends Error {}

/** Адрес запроса к контуру. Ключа в нём нет никогда — он в заголовке. */
export function upstreamUrl(platform: Platform, path: string): string {
  const url = contourUrl(platform, path);
  // Сохранённый контур адрес уже прошёл схему; сюда доезжает только подменённый
  // мимо неё — и отказ называет адрес, а не падает внутри `fetch`.
  if (url === undefined) throw new UpstreamError(`Адрес контура не http(s): ${platform.baseUrl}`);
  return url;
}

/**
 * Тело для контура: поток включается ВСЕГДА, когда шлюзу разрешено, — первые
 * токены клиент видит, пока ответ идёт, а не через две минуты молчания. Потолок
 * ответа платформы поток не снимает (`responseCeilingSec`). Расход в потоке
 * приходит отдельным кадром только если его попросить.
 */
export function forceStreamBody(
  body: Record<string, unknown>,
  forceStream: boolean,
  /** Платформа не принимает поток с таким телом (`DriverControl.streamless`). */
  refused = false,
): Record<string, unknown> {
  if (refused) {
    const { stream: _stream, stream_options: _options, ...whole } = body;
    return whole;
  }
  // compromise: nonstream-120s — контур режет любой ответ на 120 с; поток хотя бы показывает ответ, пока он идёт
  if (!forceStream && body.stream !== true) return body;
  return {
    ...body,
    stream: true,
    stream_options: { ...asRecord(body.stream_options), include_usage: true },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Стоит ли повторить — и сколько ждать. Ответ в миллисекундах или `null`
 * («не повторяем»).
 *
 * Повод ровно один: временный отказ на СТОРОНЕ контура — 429 и 5xx (план §3).
 * Дев-сервер перезапускается без предупреждения, и одна попытка через паузу
 * превращает секундную дыру в незаметную. Больше одной — уже нагрузка на
 * задыхающийся сервер вместо помощи ему.
 */
export function retryPauseMs(response: Response, now = Date.now()): number | null {
  if (response.status !== 429 && response.status < 500) return null;

  const header = response.headers.get('retry-after')?.trim();
  if (!header) return UPSTREAM_RETRY_PAUSE_MS;

  // `Retry-After` бывает секундами и датой — обе формы законны.
  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  if (!Number.isFinite(waitMs)) return UPSTREAM_RETRY_PAUSE_MS;
  if (waitMs > UPSTREAM_RETRY_MAX_PAUSE_MS) return null;
  return Math.max(waitMs, 0);
}

/**
 * Через сколько секунд контур разрешает повторить — для ТЕКСТА отказа, а не
 * для нашей паузы (её считает `retryPauseMs`, и потолок у неё свой, куда
 * меньший). Здесь наоборот: чем дольше ждать, тем важнее это сказать вслух —
 * молчаливое «слишком часто» человек читает как поломку.
 */
export function retryAfterSeconds(response: Response, now = Date.now()): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return undefined;

  const seconds = Number(header);
  const waitMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  if (!Number.isFinite(waitMs) || waitMs <= 0) return undefined;
  return Math.ceil(waitMs / 1_000);
}

/**
 * Отправить запрос в контур. Бросает `UpstreamError` с русской причиной — и
 * никогда не пробует другой адрес.
 *
 * Повтор делается ТОЛЬКО по коду ответа и только до того, как клиенту ушёл хоть
 * один байт. Обрыв связи не повторяется намеренно: запрос мог дойти и
 * исполниться, и второй такой же — это второй списанный расход у контура.
 */
export async function callUpstream(call: UpstreamCall): Promise<Response> {
  const url = upstreamUrl(call.platform, call.path);
  const fetchImpl = call.fetchImpl ?? createCaStreamFetch(call.platform.caCertPath);

  const attempt = async (): Promise<Response> => {
    // Свой потолок стоит на ЗАГОЛОВКАХ, а не на всём запросе: таймер, доживший до
    // середины потока, оборвал бы длинный ответ ровно так же, как это делает
    // 120-секундный предел контура, от которого шлюз и уходит. Он же заводится
    // заново на вторую попытку — иначе она донашивала бы остаток чужого.
    const controller = new AbortController();
    const headersTimeout = call.headersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new Error('timeout')), headersTimeout);
    const onAbort = (): void => controller.abort(call.signal?.reason);
    // Уже отменённый сигнал слушателя не позовёт никогда — а попытка вторая,
    // и клиент мог уйти как раз в паузе перед ней.
    if (call.signal?.aborted) controller.abort(call.signal.reason);
    else call.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(url, {
        method: call.method ?? 'POST',
        headers: {
          ...call.headers,
          ...contourHeaders(call.platform, call.token),
          'content-type': 'application/json',
          accept: call.accept ?? 'text/event-stream',
        },
        body: call.body,
        signal: controller.signal,
      });
      await assertNoRedirect(response, url);
      return response;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      // Потолок называется тот, что действительно стоял: у не-потоковой ручки
      // он свой, и «не ответил за 60 с» про вызов с бюджетом в две минуты —
      // это неверная причина, по которой чинят не то.
      throw new UpstreamError(describeFailure(error, headersTimeout));
    } finally {
      // Снимается ТОЛЬКО таймер заголовков. Мост отмены остаётся жить: ответ
      // отдан потоком, и уход клиента через минуту после заголовков обязан
      // оборвать поток наверху — иначе контур продолжает отвечать и списывать
      // расход в закрытое соединение. Слушатель одноразовый и умирает вместе с
      // сигналом запроса.
      clearTimeout(timer);
    }
  };

  const first = await attempt();
  if (call.retry === false) return first;

  const pause = retryPauseMs(first);
  if (pause === null) return first;

  // Тело первого ответа читать некому, а брошенный поток остался бы открытым
  // сокетом до конца процесса.
  await first.body?.cancel().catch(() => undefined);
  await sleep(pause, call.signal);
  return attempt();
}

/**
 * Перенаправление контура — ОТКАЗ, а не следующий шаг.
 *
 * Правило 1 в шапке файла целиком держится на этом: пойти по `Location` значит
 * отправить весь промпт на адрес, которого человек в настройке не писал, и
 * показать ему при этом 200. Переехавший ingress, портал перехвата, подмена на
 * пути — снаружи неотличимы, и цена ошибки одинаковая. Адрес называется, чтобы
 * настройку было чем починить; путь и параметры отбрасываются — в них бывает
 * что угодно.
 */
async function assertNoRedirect(response: Response, url: string): Promise<void> {
  if (response.status < 300 || response.status >= 400) return;
  // Тело перенаправления читать некому, а брошенный поток остался бы открытым
  // сокетом до конца процесса.
  await response.body?.cancel().catch(() => undefined);

  const location = response.headers.get('location') ?? '';
  let where = '';
  try {
    if (location) where = new URL(location, url).origin;
  } catch {
    where = '';
  }
  throw new UpstreamError(
    `Контур ответил перенаправлением${where ? ` на ${where}` : ''} (${response.status}) — панель за ним не пошла: запрос ушёл бы на другой адрес. Впишите в настройку контура тот адрес, на который он перенаправляет`,
  );
}

/** Пауза, которую можно прервать: клиент шлюза мог уйти прямо в ней. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Почему не дошли — словами и БЕЗ чужого текста заголовков: прокси и шлюзы
 * кладут в сообщение об ошибке весь запрос вместе с `Authorization`.
 */
function describeFailure(error: unknown, headersTimeoutMs: number): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'Error') {
    const message = error instanceof Error ? error.message : '';
    if (message === 'timeout' || name === 'TimeoutError') {
      return `Контур не начал отвечать за ${headersTimeoutMs / 1_000} с`;
    }
  }
  const reason = error instanceof Error ? error.message : String(error);
  if (/self.signed|unable to verify|CERT_/i.test(reason)) {
    return `Сертификат контура не проверился: ${reason}. Укажите корневой сертификат компании в настройках контура`;
  }
  // Ключ, не пролезающий в заголовок, — это не «нет связи»: запрос не ушёл.
  const badKey = headerUnsafeKeyReason(reason);
  if (badKey) return badKey;
  return `Нет связи с контуром: ${reason.slice(0, 200)}`;
}
