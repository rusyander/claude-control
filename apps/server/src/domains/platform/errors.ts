/**
 * Отказы контура — состояние, а не падение панели.
 *
 * Инвариант 7 партии: мёртвый контур не мешает панели. Поэтому недоступный
 * адрес НЕ становится ошибкой — он становится результатом пробы с причиной
 * (`probe.ts`). Ошибки здесь — только про сам запрос к панели: контура с таким
 * идентификатором нет, поле не заполнено, файл сертификата не прочитан.
 *
 * Форма `statusCode` + `code` — та же, что у интеграций и MCP: Fastify отдаёт
 * её сам, даже если маршрут её не поймал.
 */

export type PlatformErrorCode =
  'invalid_body' | 'platform_not_found' | 'platform_not_connected' | 'agents_not_declared';

const STATUS: Record<PlatformErrorCode, number> = {
  invalid_body: 400,
  platform_not_found: 404,
  platform_not_connected: 404,
  agents_not_declared: 404,
};

export class PlatformError extends Error {
  readonly statusCode: number;
  readonly code: PlatformErrorCode;
  /** Подробность: имя незаполненного поля, путь к файлу, ответ системы. */
  readonly detail?: string;

  constructor(code: PlatformErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.detail = detail;
  }
}

/** Контура с таким идентификатором нет — 404 с его именем, а не «ошибка». */
export function platformNotFound(id: string): PlatformError {
  return new PlatformError('platform_not_found', `Контура «${id}» не существует.`);
}

/** Поле запроса не заполнено — 400 с ИМЕНЕМ поля, а не «неверный запрос». */
export function invalidField(field: string, why: string): PlatformError {
  return new PlatformError('invalid_body', `Запрос не принят: ${why} (${field}).`, field);
}

/**
 * Ключ, который невозможно положить в заголовок.
 *
 * Заголовок HTTP — байты: символ выше 255 транспорт не примет, и `undici`
 * отвечает на это `Cannot convert argument to a ByteString…`. Английская
 * внутренность транспорта, попавшая в поле «причина», читается как «контур не
 * отвечает» — и человек идёт чинить сеть вместо того, чтобы посмотреть на
 * ключ, в который затесалась кириллица (обычно из скопированной вместе с
 * ключом подписи).
 *
 * Найдено живым прогоном на чужом шлюзе (Т12, `tools/qa/check-platform-foreign.mjs`).
 * Записывать такой ключ панель больше не даёт (`store.assertToken`), но ключи,
 * сохранённые раньше, уже лежат — поэтому причина разбирается и на исходящем
 * пути тоже.
 */
export function headerUnsafeKeyReason(reason: string): string | undefined {
  return /ByteString|greater than 255|Invalid character in header/i.test(reason)
    ? 'Ключ контура не годится для заголовка: в нём есть символы вне латиницы. Сохраните ключ заново, без лишних символов'
    : undefined;
}

/**
 * Символы, которые можно положить в заголовок: печатный ASCII. Ключ снаружи
 * этого набора не отправится ни при каких условиях, и узнать об этом человек
 * должен на сохранении, а не в середине рабочего дня.
 */
export const HEADER_SAFE_KEY = /^[\x20-\x7E]*$/;

/**
 * Контур выключен или без ключа. 404, а не 502: панель ещё никуда не ходила,
 * и показывать «не отвечает» по ненастроенному контуру значило бы врать.
 */
export function notConnected(title: string): PlatformError {
  return new PlatformError(
    'platform_not_connected',
    `Контур «${title}» не подключён: включите его и сохраните ключ.`,
  );
}

/**
 * Тип контура не объявил агентов. 404 до сети: чужой форме запроса шлюз ответил
 * бы своим 404, и человек пошёл бы искать в админке идентификатор агента,
 * которого у этого шлюза не бывает.
 */
export function agentsNotDeclared(title: string): PlatformError {
  return new PlatformError(
    'agents_not_declared',
    `У контура «${title}» нет опубликованных агентов: его тип их не объявляет.`,
  );
}
