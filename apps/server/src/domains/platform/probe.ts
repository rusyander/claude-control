import type { Platform, PlatformProbeResult } from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import { createCaFetch, type PlatformFetch } from './ca-fetch.ts';
import { headerUnsafeKeyReason } from './errors.ts';
import { foreignTail as tail, redactSecrets } from './redact.ts';
import { driverOf } from './drivers/index.ts';
import { contourHeaders, contourUrl } from './transport.ts';
import { catalogItems, type PlatformDriver } from './drivers/driver.ts';
import { bridgeUpstreamStatus } from './gateway/status.ts';
import { retryAfterSeconds } from './gateway/upstream.ts';

/**
 * Проба контура: панель спрашивает у него СПИСОК МОДЕЛЕЙ.
 *
 * Почему список, а не пробная генерация: список ничего не стоит и ничего не
 * расходует, а отвечает сразу на три вопроса — адрес жив, ключ принят, что
 * ключу выдано. Генерация тратит деньги и лимиты, и делать её в фоне ради
 * галки в матрице панель не станет.
 *
 * ПЯТЬ ИСХОДОВ, А НЕ ДВА. «Не отвечает» и «отвечает не тем» чинятся
 * по-разному, и самая частая ошибка настройки — адрес админки вместо адреса
 * API — обязана называться отдельно, иначе человек идёт чинить сеть.
 *
 * БЕЗОПАСНОСТЬ: ключ уходит только в заголовок запроса. Наружу возвращается
 * адрес БЕЗ ключа, а чужой текст перед показом ЧИСТИТСЯ от секретов и только
 * потом обрезается (`redactSecrets` → `tail`): сервер контура вполне может
 * отразить присланный ключ в теле ошибки, а это тело оседает в `state.json` и
 * уезжает экспортом настроек на другую машину.
 */

/** Потолок ожидания. Корпоративный шлюз за прокси отвечает не мгновенно. */
export const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeOptions {
  platform: Platform;
  token: string | undefined;
  /** Транспорт. По умолчанию — свой, знающий про корневой сертификат компании. */
  fetchImpl?: PlatformFetch;
  now?: () => Date;
}

/**
 * Ответ пришёл не от модельного API: страница входа, портал, чужой сервис.
 * Подсказку про сам адрес даёт ДРАЙВЕР: «публичный API обычно на api.<домен>»
 * верно для одной платформы и выдумка для произвольного шлюза.
 */
function notApiDetail(driver: PlatformDriver, url: string, status: number, hint: string): string {
  const address = driver.addressHint?.(url);
  return `Адрес ответил ${status}, но это не список моделей: ${hint}.${address ? ` ${address}` : ''}`;
}

/** Пустой каркас ответа: у неудачной пробы всё, кроме исхода и причины, пусто. */
function empty(url: string, checkedAt: string): Omit<PlatformProbeResult, 'outcome' | 'detail'> {
  return {
    reachable: false,
    url,
    models: [],
    capabilities: [],
    limits: {},
    notes: [],
    compromises: [],
    checkedAt,
  };
}

/**
 * Проверить контур. Возвращает результат, а не бросает: недоступный контур —
 * это состояние карточки с причиной, а не сбой панели (инвариант 7).
 *
 * Единственное исключение — нечитаемый файл корневого сертификата: это ошибка
 * НАСТРОЙКИ, а не связи, и она приходит из `createCaFetch` отдельным отказом с
 * именем поля.
 */
export async function probePlatform(options: ProbeOptions): Promise<PlatformProbeResult> {
  const { platform, token } = options;
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const driver = driverOf(platform);
  const url = contourUrl(platform, 'models');
  const base = empty(url ?? platform.baseUrl, checkedAt);

  const parsed = url === undefined ? undefined : parseHttpUrl(url);
  if (!parsed || url === undefined) {
    return {
      ...base,
      outcome: 'unreachable',
      detail: 'Адрес контура должен быть корректным http(s)-адресом.',
    };
  }

  const fetchImpl = options.fetchImpl ?? createCaFetch(platform.caCertPath);

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      headers: contourHeaders(platform, token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ...base, outcome: 'unreachable', detail: describeNetworkFailure(error, token) };
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') ?? '';
  const text = await readBody(response);

  if ((status === 401 || status === 403) && !token) {
    // Проба без ключа (первый шаг мастера): отказ здесь подтверждает адрес, а не
    // бракует ключ, которого человек ещё не вводил.
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'no-key',
      detail: `Адрес отвечает как API контура и без ключа отказал (${status}) — так и должно быть: ключ ещё не введён. Введите его на следующем шаге.`,
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'unauthorized',
      detail:
        status === 401
          ? // Ровно тот текст, что скажет шлюз на тот же код, — и берётся он
            // ТЕМ ЖЕ переводом отказа, а не поиском строки по манифесту с
            // запасным литералом рядом. Запасной литерал здесь и был расхождением:
            // общую фразу про 401 он повторял копией, и правка общей таблицы
            // молча разводила кнопку «Проверить связь» с отказом шлюза. У
            // платформы компании причин пять сразу («перевыпустите ключ» отправило бы
            // человека с кончившимся бюджетом чинить не то), у произвольного
            // шлюза панель их не знает и не выдумывает — оба случая уже решены
            // одним переводом.
            `${bridgeUpstreamStatus(401, {}, { driverRows: driver.statusRows }).message} (401).`
          : 'Ключу не разрешено то, что запросила панель (403). Проверьте права ключа.',
    };
  }

  // 429 и 503 — «контур жив, но сейчас не ответит», и объясняются ТЕМ ЖЕ
  // переводом, что и отказ шлюза (аудит DRV-16): лимитёр платформы компании стоит и на
  // списке моделей, а «реестр моделей не готов» — смысл 503 у неё, не у всех.
  if (status === 429 || status === 503) {
    const bridged = bridgeUpstreamStatus(
      status,
      {},
      {
        driverRows: driver.statusRows,
        retryAfterSeconds: retryAfterSeconds(response),
      },
    );
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-ready',
      detail: `${bridged.message} (${status}). Повторите проверку.`,
    };
  }

  if (status >= 500) {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-ready',
      detail: `Контур ответил ошибкой ${status}. Это его сторона — повторите позже.`,
    };
  }

  if (status >= 400) {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-api',
      detail: notApiDetail(
        driver,
        url,
        status,
        tail(text, token) || 'список моделей по этому пути не найден',
      ),
    };
  }

  // Ответ формально удачный. Дальше два способа получить «не то»: HTML вместо
  // JSON (страница входа перед шлюзом) и JSON без списка моделей.
  if (contentType.includes('text/html')) {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-api',
      detail: notApiDetail(driver, url, status, 'вернулась HTML-страница, а не JSON'),
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-api',
      detail: notApiDetail(driver, url, status, 'ответ не разбирается как JSON'),
    };
  }

  if (!catalogItems(payload)) {
    return {
      ...base,
      reachable: true,
      status,
      outcome: 'not-api',
      detail: notApiDetail(
        driver,
        url,
        status,
        'в ответе нет списка моделей (ни поля data, ни массива)',
      ),
    };
  }

  const reading = driver.read(payload);
  // compromise: key-cache-lag — удачная проверка не значит, что ключ ещё жив: контур какое-то время принимает отозванный
  const compromises: CompromiseId[] = token
    ? [...reading.compromises, 'key-cache-lag']
    : reading.compromises;

  return {
    outcome: 'ok',
    reachable: true,
    url,
    status,
    detail: `Контур ответил: моделей ${reading.models.length}.`,
    models: reading.models,
    capabilities: reading.capabilities,
    limits: reading.limits,
    notes: reading.notes,
    compromises,
    checkedAt,
  };
}

/** Только http(s): по file: и ftp: панель не ходит даже с ведома человека. */
function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Не дошли вовсе: нет сети, не разобрался адрес, вышло время, чужой сертификат. */
function describeNetworkFailure(error: unknown, token: string | undefined): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Контур не ответил за ${PROBE_TIMEOUT_MS / 1_000} с.`;
  }
  // Текст ошибки транспорта тоже чужой: прокси и шлюзы кладут в него заголовки
  // запроса целиком, вместе с `Authorization`.
  const reason = redactSecrets(error instanceof Error ? error.message : String(error), token);
  // Свой корневой сертификат компании — законная настройка, и подсказать про
  // неё надо ровно там, где узел доверия и ломается.
  if (/self.signed|unable to verify|CERT_/i.test(reason)) {
    return `Сертификат контура не проверился: ${reason}. Укажите корневой сертификат компании в настройках контура.`;
  }
  // Запрос с таким ключом не ушёл вовсе — это не свойство контура, и назвать
  // его надо ключом, иначе человек пойдёт чинить сеть.
  const badKey = headerUnsafeKeyReason(reason);
  if (badKey) return `${badKey}.`;
  return `Нет связи с контуром: ${reason}.`;
}
