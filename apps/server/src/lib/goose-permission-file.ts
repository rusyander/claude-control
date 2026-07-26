import { parse as parseYaml } from 'yaml';

/**
 * Пофайловые разрешения инструментов Goose — `permission.yaml` рядом с
 * `config.yaml`. ТОЛЬКО ЧТЕНИЕ.
 *
 * Почему только чтение: в опубликованной документации Goose формата этого файла
 * НЕТ. Задокументированы лишь три уровня («Always Allow» / «Ask Before» /
 * «Never Allow») и путь настройки — `goose configure`. Структура ключей известна
 * из исходников CLI, а правило провайдерного слоя однозначно: чужой формат
 * пишем только по документации. Значит панель показывает, что уже настроено, и
 * не трогает файл — тогда расхождение с будущей версией Goose стоит неверной
 * подписи в интерфейсе, а не испорченных прав.
 *
 * Ожидаемая форма (по исходникам `crates/goose/src/config/permission.rs`):
 *
 *     user:
 *       always_allow: [developer__shell]
 *       ask_before: [developer__text_editor]
 *       never_allow: [computercontroller__web_scrape]
 *     smart_approve:
 *       always_allow: [...]
 *
 * Раздел `user` — решения человека; `smart_approve` — кеш решений LLM, его
 * панель не показывает (это не настройка, а кеш). Всё, что не сходится с этой
 * формой, читатель молча пропускает: чтение обязано быть неразрушающим и не
 * ронять раздел прав из-за незнакомого ключа.
 */

/** Три уровня, ровно как названы в интерфейсе Goose. */
export interface GooseToolPermissions {
  alwaysAllow: string[];
  askBefore: string[];
  neverAllow: string[];
}

/** Имена инструментов одного списка. Не список строк → пусто (форму не гадаем). */
function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

/**
 * Разобрать текст `permission.yaml`. Файл пуст, не разбирается или не имеет
 * раздела `user` → `undefined`: показывать нечего, но и ошибки нет.
 */
export function readGooseToolPermissions(text: string): GooseToolPermissions | undefined {
  if (!text.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    // Битый файл — не повод гасить раздел прав: режим живёт в другом файле.
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const user = (parsed as Record<string, unknown>).user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return undefined;

  const section = user as Record<string, unknown>;
  const permissions: GooseToolPermissions = {
    alwaysAllow: toolNames(section.always_allow),
    askBefore: toolNames(section.ask_before),
    neverAllow: toolNames(section.never_allow),
  };

  const empty =
    permissions.alwaysAllow.length === 0 &&
    permissions.askBefore.length === 0 &&
    permissions.neverAllow.length === 0;

  return empty ? undefined : permissions;
}
