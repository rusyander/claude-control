import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * OpenCode → канон.
 *
 * Хуки у OpenCode устроены иначе, чем у всех: не «событие → команда», а два
 * описанных события (`file_edited`, `session_completed`) с действиями-argv.
 * Приведение к общей форме — `opencodeHookInputs`, и оно НЕ склеивает argv в
 * строку: OpenCode запускает команду без оболочки, и склейка изменила бы смысл
 * при пробелах внутри аргумента.
 *
 * Переменных окружения у OpenCode нет вовсе — только подстановка
 * `{env:ПЕРЕМЕННАЯ}` из окружения процесса; раздел уходит пропуском «этого
 * раздела нет», а не пустым списком.
 */
export const importOpencodeEnvironment: Importer = (deps) => readUniversalSections(deps);
