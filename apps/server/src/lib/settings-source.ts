/**
 * Префикс идентификатора у записей из `settings.local.json`.
 *
 * Тот же самый префикс объявлен в `packages/contracts/src/settings-source.ts`
 * для фронтенда. Здесь он продублирован намеренно: пакет contracts
 * реэкспортирует модули без расширений, и Node ESM такой импорт не резолвит —
 * в сервер оттуда можно брать только типы (`import type`). Значение,
 * пришедшее из contracts, упало бы в рантайме, хотя типы бы собрались.
 */
export const LOCAL_ID_PREFIX = 'local:';

/**
 * Идентификаторы хуков и прав позиционные (событие плюс индексы, решение плюс
 * паттерн), поэтому в двух файлах настроек они совпадают. Префикс разводит их
 * и заодно служит признаком «эту запись править нельзя».
 */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/**
 * Идентификатор без префикса — таким его знает сам файл. Префикс живёт только
 * в панели, чтобы развести одинаковые записи двух файлов.
 */
export function stripLocalPrefix(id: string): string {
  return isLocalId(id) ? id.slice(LOCAL_ID_PREFIX.length) : id;
}
