import { createHash } from 'node:crypto';
import type { WatchSignal } from './types.ts';

/**
 * Отпечаток сбоя: одна причина — одна запись и один раздел отчёта, повтор
 * обновляет раздел и счётчик, а не пишет второй.
 *
 * Причина — это текст без изменчивых частей плюс место в коде. Место — у сбоя
 * запроса его маршрут (метод и путь с `:id`), у остальных — верхний кадр стека.
 * Вид и источник в отпечаток НЕ входят: один отказ маршрута приходит и
 * ответом сервера, и отказом на странице, и это одна причина, а не две. Статус
 * тоже не входит — 502 и 503 одного маршрута с одним текстом одинаковы.
 *
 * Что выбрасывается перед хэшем — ровно то, что меняется от раза к разу при
 * той же причине: числа (порты, pid, время, номера строк в собранном коде),
 * длинные шестнадцатеричные и uuid-идентификаторы, строка запроса. Имя файла
 * верхнего кадра стека остаётся: две разные ошибки с одним текстом в разных
 * модулях — разные сбои.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX = /\b[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+/g;

/** Текст без изменчивых частей. */
export function normalizeText(text: string): string {
  return text.replace(UUID, '<id>').replace(LONG_HEX, '<id>').replace(NUMBER, '#').trim();
}

/**
 * Сегмент пути — значение, а не часть маршрута: число, длинный токен с цифрой
 * (uuid, хэш, `run-1718293`), очень длинный или `:name` шаблона. Короткое слово с
 * цифрой — `e2e`, `v1`, `oauth2` — часть маршрута: раньше любая цифра делала
 * сегмент `:id`, и `/project-tests/e2e` сливался с `/project-tests/x1`.
 */
function isValueSegment(part: string): boolean {
  if (part.startsWith(':') || /^\d+$/.test(part) || part.length > 24) return true;
  return part.length >= 8 && /\d/.test(part);
}

/** Путь запроса без строки запроса и с идентификаторами вместо значений. */
export function normalizePath(path: string): string {
  const bare = path.split('?')[0] ?? '';
  return (
    bare
      .split('/')
      // `:name` шаблона сервера и `42` адреса страницы — одно и то же место.
      .map((part) => (isValueSegment(part) ? ':id' : part))
      .join('/')
  );
}

/** Строка стека — кадр: `at …` у V8, `fn@url` у Firefox и Safari. */
const FRAME_LINE = /^\s*at\s|@/;
const FRAME_FILE = /([^\s()/\\@]+\.(?:[cm]?[jt]sx?))(?::\d+)*/;
/** Хэш чанка сборки (`index-BdX8k2Qa.js`): в нём есть цифра или заглавная буква. */
const CHUNK_HASH = /[-.](?=[\w-]{8}\.)(?=[\w-]*[\dA-Z])[\w-]{8}(?=\.[cm]?[jt]sx?$)/;

/**
 * Первый кадр стека, указывающий в файл: имя файла без номера строки. Номера
 * меняются от любой правки выше по файлу, и один и тот же сбой получал бы новый
 * отпечаток после каждого перезапуска dev-сборки — по той же причине снят хэш
 * чанка собранного файла. Заголовок «TypeError: …» есть только у V8: у Firefox и
 * Safari первая строка — уже верхний кадр, и пропускать её нельзя.
 */
export function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  for (const line of stack.split('\n')) {
    if (!FRAME_LINE.test(line)) continue;
    const match = FRAME_FILE.exec(line);
    if (match) return (match[1] ?? '').replace(CHUNK_HASH, '');
  }
  return '';
}

/**
 * Сигналы о запросе: место причины — маршрут, а не стек. У зависшей загрузки
 * `path` — ключ запроса страницы, и он же её место.
 */
const REQUEST_KINDS = new Set<WatchSignal['kind']>([
  'http-5xx',
  'http-4xx',
  'api-failure',
  'slow-request',
  'contract-mismatch',
]);

/**
 * Медленный ответ и зависшая загрузка — свойство места, а не текста: в тексте
 * длительность, и каждое «дольше 6.2 с» иначе стало бы новой причиной.
 */
const PLACE_ONLY_KINDS = new Set<WatchSignal['kind']>(['slow-request', 'stuck-loading']);

export function fingerprintOf(signal: WatchSignal): string {
  const place =
    (REQUEST_KINDS.has(signal.kind) || PLACE_ONLY_KINDS.has(signal.kind)) && signal.path
      ? `${(signal.method ?? '').toUpperCase()} ${normalizePath(signal.path)}`
      : topFrame(signal.stack);
  const parts = PLACE_ONLY_KINDS.has(signal.kind)
    ? [signal.kind, place || normalizeText(signal.message).slice(0, 300)]
    : [normalizeText(signal.message).slice(0, 300), place];
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/** Отпечаток замечания: файл без строки и заголовок без чисел и регистра. */
export function remarkFingerprint(title: string, location: string | undefined): string {
  const file = (location ?? '').replace(/:\d+(?::\d+)?$/, '').trim();
  const key = ['remark', file, normalizeText(title).toLowerCase().slice(0, 200)];
  return createHash('sha1').update(key.join('\n')).digest('hex').slice(0, 12);
}
