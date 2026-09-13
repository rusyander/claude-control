/**
 * Коды контура → отказ, понятный клиенту.
 *
 * Половина кодов контура клиенту незнакома, и хуже всех **451**: ни один CLI
 * его не ждёт — покажет сырое тело или решит, что сломался сервер. Мост
 * переводит его в обычный отказ запроса, а ПРИЧИНУ оставляет панели.
 *
 * Что здесь никогда не появится: сам текст, на котором сработала проверка. В
 * тело 451 контур кладёт перечень нарушений, и в нём вполне может лежать кусок
 * запроса. Наружу и в след запроса уходят только НАЗВАНИЯ нарушенного —
 * поэтому имена собираются по белому списку полей, а не «всё, что строка», и
 * перечень из голых строк проходит ещё более узкое сито (`CATEGORY_WORD`): у
 * такой строки нет поля, по которому видно, что это категория, а по форме
 * ключ доступа от названия проверки не отличается.
 */

import type { DriverStatusRow, DriverViolationName } from '../drivers/driver.ts';

/** Как отвечать клиенту на каждый известный код контура. */
export interface BridgedStatus {
  /** Код, который увидит клиент. */
  status: number;
  /** Код ошибки в теле — по нему клиент ветвится, не разбирая текст. */
  code: string;
  /** Русская причина словами. */
  message: string;
  /** Названия сработавших проверок (только для 451). */
  violations: string[];
}

/**
 * Таблица кодов (справочник §8). Русский текст — свой: тот, что приходит от
 * контура, годится не всегда (у 451 в теле лежит перечень, а не фраза), и
 * подставляется отдельно, когда он есть.
 *
 * Здесь только то, что читается одинаково у ЛЮБОГО совместимого шлюза. Код,
 * которого у других нет (451), и код, чья причина у этой платформы своя (401
 * с пятью причинами), приезжают строками драйвера и ложатся поверх.
 */
const CODES: Record<number, { status: number; code: string; message: string }> = {
  400: { status: 400, code: 'invalid_request_error', message: 'Контур не принял запрос' },
  401: {
    status: 401,
    code: 'authentication_error',
    message: 'Контур отклонил ключ. Проверьте сам ключ и его права',
  },
  402: {
    status: 402,
    code: 'billing_error',
    message: 'Контур отказал по лимиту расхода — до вызова модели',
  },
  403: {
    status: 403,
    code: 'permission_error',
    message: 'Ключу не разрешена эта модель на контуре',
  },
  404: { status: 404, code: 'not_found_error', message: 'Контур не знает такого маршрута' },
  // 413 приходит от самого шлюза, а не от контура, но клиент читает его тем же
  // разбором, и общий «код 413» ему ничего не объясняет.
  413: {
    status: 413,
    code: 'invalid_request_error',
    message: 'Запрос больше того, что контур принимает',
  },
  422: {
    status: 422,
    code: 'invalid_request_error',
    message: 'Контур не принял форму запроса',
  },
  429: {
    status: 429,
    code: 'rate_limit_error',
    message: 'Превышен лимит ключа на контуре (запросов или токенов в минуту)',
  },
  // 451 стоит в ОБЩЕЙ таблице, хотя перечень проверок из его тела читает только
  // тот, кто про этот перечень объявил. Смысл кода задан RFC 7725, а не
  // платформа компании: шлюз компании с внешним фильтром содержимого отвечает им же, и
  // без строки здесь такой ответ уезжал бы клиенту сырым 451 — ровно тем, чего
  // мост не должен допускать («ни один CLI его не ждёт»).
  451: {
    status: 400,
    code: 'content_policy_violation',
    message: 'Запрос остановлен проверками содержимого на стороне контура',
  },
  500: { status: 502, code: 'api_error', message: 'Контур ответил ошибкой на своей стороне' },
  502: { status: 502, code: 'api_error', message: 'Контур не смог дозваться до модели' },
  503: { status: 503, code: 'overloaded_error', message: 'Контур сейчас недоступен' },
};

/**
 * Поля, из которых берутся названия нарушений, когда драйвер своих не объявил.
 * Всё прочее не читается.
 */
const VIOLATION_FIELDS: readonly DriverViolationName[] = [
  'category',
  'guardrail',
  'name',
  'rule',
  'type',
  'code',
].map((field) => ({ field }));

/** Потолок названия правила, написанного прозой. */
const LABEL_MAX = 64;

/**
 * Название нарушения — только идентификатор: латиница, цифры и разделители, без
 * пробелов. Прозе (в том числе кириллице) сюда хода нет: это единственный
 * надёжный способ не вынести наружу проверявшийся текст.
 */
const IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;

/**
 * Название, пришедшее ГОЛОЙ СТРОКОЙ, принимается строже: у него нет поля, по
 * которому видно, что это категория. `["AKIAIOSFODNN7EXAMPLE"]`,
 * `["db.internal.corp.ru"]` и 64 знака шестнадцатеричного ключа — законный
 * идентификатор по форме, и любое из них уехало бы на экран панели как
 * «название проверки». Поэтому здесь только слова: строчные буквы, дефис и
 * подчёркивание, без цифр и точек.
 */
const CATEGORY_WORD = /^[a-z][a-z_-]{1,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Название, написанное администратором: управляющие знаки и переводы строк
 * схлопываются (его читают в консоли CLI), длина режется с видимой обрезкой.
 */
function labelOf(value: string): string {
  const flat = value
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX)}…` : flat;
}

/** Названия сработавших проверок из тела контура. Текста запроса здесь нет. */
export function readViolations(
  payload: unknown,
  fields: readonly DriverViolationName[] = VIOLATION_FIELDS,
): string[] {
  const source = isRecord(payload) ? payload : {};
  const list = Array.isArray(source.violations)
    ? source.violations
    : isRecord(source.error) && Array.isArray(source.error.violations)
      ? source.error.violations
      : [];

  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (CATEGORY_WORD.test(item) && !names.includes(item)) names.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    // Сначала поля платформы, за ними общий список: другая сборка той же
    // платформы или соседний шлюз вправе назвать нарушение `category`.
    for (const { field, label } of fields === VIOLATION_FIELDS
      ? fields
      : [...fields, ...VIOLATION_FIELDS]) {
      const raw = item[field];
      if (typeof raw !== 'string') continue;
      const value = label ? labelOf(raw) : raw;
      if (!value || (!label && !IDENTIFIER.test(value))) continue;
      if (!names.includes(value)) names.push(value);
      break;
    }
  }
  return names;
}

/** Потолок фразы из `detail`: объяснение отказа, а не дамп. */
const DETAIL_LIMIT = 300;

/** Фраза из тела контура, если он её прислал. */
function upstreamMessage(payload: unknown): string {
  if (!isRecord(payload)) return '';
  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message.trim();
  }
  if (typeof payload.message === 'string') return payload.message.trim();
  return fastApiDetail(payload.detail);
}

/**
 * `detail` FastAPI: строка у `HTTPException`, список у ошибки схемы (422).
 * Из элементов списка берутся только `loc` и `msg` — в `input` лежит сам
 * запрос, и наружу он не уезжает.
 */
function fastApiDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail.trim().slice(0, DETAIL_LIMIT);
  if (!Array.isArray(detail)) return '';
  return detail
    .filter(isRecord)
    .filter((item) => typeof item.msg === 'string')
    .slice(0, 3)
    .map((item) => {
      const loc = Array.isArray(item.loc)
        ? item.loc.filter((part) => typeof part === 'string' && part !== 'body').join('.')
        : '';
      return loc ? `${loc}: ${String(item.msg)}` : String(item.msg);
    })
    .join('; ')
    .slice(0, DETAIL_LIMIT);
}

/** Про что был запрос — этим уточняются отказы, зависящие от модели. */
export interface BridgeContext {
  /** Модель из тела запроса. Пусто — ручка её не называет (`/models`). */
  model?: string;
  /** `Retry-After` контура в секундах: без него 429 не говорит, когда повторить. */
  retryAfterSeconds?: number;
  /**
   * Отказы, которые умеет объяснить только эта платформа (манифест драйвера).
   * Ложатся ПОВЕРХ общей таблицы: код, которого в ней нет, добавляется, код,
   * который там есть, — уточняется. Пустой список — законный ответ («своих
   * причин нет»), а вот ОТСУТСТВИЕ аргумента законным не было бы: забытый на
   * новом маршруте, он молча превращал бы 451 в общий отказ без перечня.
   */
  driverRows: readonly DriverStatusRow[];
  /** Где у этой платформы лежит название нарушения (`driver.violationNames`). */
  violationNames?: readonly DriverViolationName[];
}

/**
 * Имя модели в тексте отказа. Значение приходит из тела запроса, то есть от
 * клиента, а читают его в консоли CLI — поэтому переводы строк и управляющие
 * знаки схлопываются в пробел: иначе чужая строка дорисовала бы в консоли
 * собственные «строки отказа». Длину режем так, чтобы обрезку было видно.
 */
function modelName(model: string | undefined): string {
  // `\p{C}` — управляющие и форматирующие знаки целиком, без перечисления
  // диапазонов: перевод строки, возврат каретки, escape-последовательность.
  const value = (model ?? '')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

/** «через 12 с» — если контур сказал, когда повторять. */
function retryHint(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const rounded = Math.min(Math.ceil(seconds), 24 * 60 * 60);
  return `. Контур просит повторить через ${rounded} с`;
}

/**
 * Перевести ответ контура в отказ клиенту.
 *
 * Текст контура приходит по-русски и уже вычищен от секретов (справочник §8) —
 * его и показываем, дописав, чей это отказ. Отсутствие текста не молчание: у
 * каждого кода есть своя фраза, потому что «ошибка 402» человеку не говорит
 * ничего, а «бюджет ключа исчерпан» говорит всё.
 *
 * Два кода уточняются моделью, потому что без её имени они бесполезны: 403
 * («какая именно не разрешена?») и 404 на ручке чата, где «нет такого
 * маршрута» человеку не говорит ничего.
 *
 * У 404 названы ОБА чтения, и это не осторожность ради осторожности. Шлюз
 * всегда стучится в один и тот же путь под адресом контура, поэтому 404
 * одинаково означает и «модель убрали между прогонами» (§8 №13), и «адрес
 * контура указывает не на публичный API» (§8 №1) — например, на админку.
 * Назвать одно из двух значило бы отправить половину людей чинить не то, а
 * различить их здесь нечем: тела у такого ответа обычно нет вовсе.
 */
export function bridgeUpstreamStatus(
  status: number,
  payload: unknown,
  context: BridgeContext,
): BridgedStatus {
  const row = context.driverRows.find((item) => item.upstream === status);
  const known = row ? { status: row.status, code: row.code, message: row.message } : CODES[status];
  // Перечень нарушенного читается только там, где платформа сказала, что он в
  // теле есть. Общего «на 451 читаем violations» тут нет намеренно: код чужого
  // шлюза может значить что угодно, а разбор чужого тела наугад — это способ
  // вынести наружу проверявшийся текст.
  const violations = row?.violations ? readViolations(payload, context.violationNames) : [];
  const detail = upstreamMessage(payload);
  const model = modelName(context.model);

  if (model && (status === 403 || status === 404)) {
    const message =
      status === 403
        ? `Ключу не разрешена модель «${model}» на контуре — список разрешённых у ключа в админке платформы, а в разделе «Контур» видно то же самое списком моделей`
        : `Контур ответил «не найдено» на запрос модели «${model}». Читается это двояко: модель убрали из контура между прогонами (в разделе «Контур» пропавшие помечены и хранят дату последней встречи) — либо адрес контура указывает не на публичный API, а, например, на админку, и тогда не найден маршрут, а не модель`;
    // Код и статус берём из таблицы, а не повторяем числами: иначе правка
    // таблицы (451 там уже отдаётся клиенту как 400) тихо разошлась бы с этой
    // веткой, и один и тот же код отвечал бы по-разному в зависимости от того,
    // назвали модель или нет.
    return {
      status: known?.status ?? status,
      code: known?.code ?? 'invalid_request_error',
      message: detail ? `${message}: ${detail}` : message,
      violations,
    };
  }

  if (!known) {
    return {
      status: status >= 400 && status < 600 ? status : 502,
      code: status >= 500 ? 'api_error' : 'invalid_request_error',
      message: detail || `Контур ответил кодом ${status}`,
      violations,
    };
  }

  // У отказа по содержимому перечень нарушенного и есть причина: приписывать к
  // нему чужую фразу незачем, а вот названия проверок человеку нужны.
  const body = row?.violations
    ? violations.length > 0
      ? `${known.message}: ${violations.join(', ')}`
      : known.message
    : detail
      ? `${known.message}: ${detail}`
      : known.message;

  // «Когда повторить» у 429 — половина сценария §8 №9, и знает её только
  // контур: свой авто-повтор шлюз делает молча и ровно один, а дальше решает
  // человек или клиент. Без секунд «слишком часто» не отличается от «сломалось».
  const message = status === 429 ? `${body}${retryHint(context.retryAfterSeconds)}` : body;

  return { status: known.status, code: known.code, message, violations };
}
