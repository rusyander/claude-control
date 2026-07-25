import { parseDocument, isMap, type Document } from 'yaml';
import { UnrecognizedFormatError } from './codex-toml.ts';
import { stripBom } from './text-form.ts';

/**
 * Общая основа round-trip-правки YAML-конфигураций чужих CLI (Continue, Goose).
 * Здесь ровно то, что у них одинаково: разбор в `Document`, безопасное удаление
 * ключа и проекция «всех прочих ключей» для сверки перед записью. Формы самих
 * блоков у провайдеров разные и живут в своих файлах (`continue-yaml.ts`,
 * `goose-yaml.ts`) — сюда они не просачиваются.
 *
 * ПОЧЕМУ Document API, а не `parse` + `stringify`: конфиг пользователя — живой
 * файл с комментариями и порядком ключей, который он расставил сам. Полная
 * пересборка стёрла бы и то и другое. Document правит ДЕРЕВО: меняется только
 * нужный узел, всё остальное остаётся байт в байт.
 */

/**
 * Разобрать YAML-конфигурацию, корень которой обязан быть отображением. Пустой
 * файл (или файл из одних комментариев) валиден: ключи добавим сами. Ошибка
 * разбора или корень-не-карта → fail-closed. BOM снимается перед разбором
 * (Блокнот и PowerShell пишут именно так), обратно его вернёт `writeTextFile`.
 */
export function parseYamlMapDocument(text: string): Document {
  const doc = parseDocument(stripBom(text));
  if (doc.errors.length > 0) throw new UnrecognizedFormatError();
  if (doc.contents !== null && !isMap(doc.contents)) throw new UnrecognizedFormatError();
  return doc;
}

/**
 * Удалить ключ верхнего уровня. У пустого документа (пустой файл или одни
 * комментарии) корня-коллекции ещё нет, и `Document.delete` на нём бросает —
 * удалять там нечего, поэтому просто выходим.
 */
export function deleteYamlKey(doc: Document, key: string): void {
  if (doc.contents === null) return;
  doc.delete(key);
}

/**
 * Все ключи верхнего уровня, КРОМЕ указанных, стабильной строкой. Нужна для
 * сверки «панель поменяла только своё»: ключи сортируются, поэтому сравнивается
 * содержимое, а не порядок обхода.
 */
export function otherYamlKeysProjection(doc: Document, exceptKeys: readonly string[]): string {
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '{}';
  const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of exceptKeys) delete rest[key];
  return JSON.stringify(rest, Object.keys(rest).sort());
}
