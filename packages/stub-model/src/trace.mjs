/**
 * След запросов — доказательство (P88): что дошло до модели, каким протоколом и что
 * она ответила. Строка JSON на запрос, дописывается синхронно ДО ответа: CLI,
 * упавший на ответе, след всё равно оставил.
 *
 * Значение доступа в след не попадает никогда (F-78): у заголовков доступа (по имени —
 * authorization, *-api-key, *token*, cookie …) пишется только «есть», у параметров
 * адреса с именем ключа/секрета/токена/подписи — тоже, у полей тела с таким именем на
 * любой глубине (JSON) и у параметров тела-формы — тоже. Остальное тело пишется как
 * есть: оно и есть то, что проверка судит (`max_tokens`, `input_tokens` — счёт, не доступ).
 * Адрес не пересобирается: заменяется только значение такого параметра, прочие байты
 * остаются как их прислал клиент. `requests[]` в памяти хранит тело целиком — сценарий
 * ищет в нём метки; это данные самого вызывающего, на диск они идут только через след.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CREDENTIAL_HEADER = /authorization|api[-_]?key|token|secret|cookie|session|password/i;
/** Параметр адреса или формы: имя — ключ, секрет, токен, пароль, подпись, доступ. */
const CREDENTIAL_PARAM =
  /^(?:key|auth|sig|signature|code)$|api[-_]?key|token|secret|passw(?:or)?d|credential/i;
/**
 * Поле тела: строже, чем параметр — в теле модели живут `max_tokens`, `input_tokens`,
 * `budget_tokens`; они не доступ. Секрет — точное имя или имя с хвостом `_secret`,
 * `_api_key`, `_password`, `access_token`, `refreshToken` и т.п.
 */
const CREDENTIAL_FIELD =
  /^(?:.*[-_])?(?:api[-_]?key|apikey|secret|password|passwd|private[-_]?key|credentials?)$|^(?:token|authorization|bearer|cookie)$|(?:access|refresh|id|auth|session|bearer|api|oauth|client)[-_]?token$|(?:client|app)[-_]?secret$/i;

export const PRESENT = '<present>';

/** Заголовки запроса без значений доступа: имя остаётся, значение — «есть». */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[name] = CREDENTIAL_HEADER.test(name) ? PRESENT : value;
  }
  return out;
}

/** Имя параметра из сырого отрезка `имя=значение` (с процентной записью и `+`). */
function paramName(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** Строка `a=1&b=2` с заменой значений доступа; прочие отрезки — байт в байт. */
function redactParams(text) {
  return text
    .split('&')
    .map((segment) => {
      const at = segment.indexOf('=');
      if (at < 0) return segment;
      return CREDENTIAL_PARAM.test(paramName(segment.slice(0, at)))
        ? `${segment.slice(0, at)}=${PRESENT}`
        : segment;
    })
    .join('&');
}

/** Адрес запроса без значений ключей в строке запроса. */
export function redactUrl(url) {
  const at = url.indexOf('?');
  if (at < 0) return url;
  return `${url.slice(0, at)}?${redactParams(url.slice(at + 1))}`;
}

/** Тело JSON без значений полей доступа, на любой глубине. */
export function redactBody(value) {
  if (Array.isArray(value)) return value.map(redactBody);
  if (typeof value !== 'object' || value === null) return value;
  const out = {};
  for (const [name, field] of Object.entries(value))
    out[name] = CREDENTIAL_FIELD.test(name) ? PRESENT : redactBody(field);
  return out;
}

const FORM = /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+(?:=[^\s&]*)?)*$/;

/** Сырое тело (не JSON): форма `a=1&b=2` — без значений доступа, прочее — как есть. */
export function redactRaw(raw) {
  return FORM.test(raw) ? redactParams(raw) : raw;
}

/** Писатель следа в файл, который назвал вызывающий; без файла — ничего. */
export function traceWriter(file) {
  if (!file) return () => {};
  mkdirSync(dirname(file), { recursive: true });
  return (record) => appendFileSync(file, `${JSON.stringify(record)}\n`);
}
