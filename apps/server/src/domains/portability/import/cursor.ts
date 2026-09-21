import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Cursor CLI → канон.
 *
 * Инструкции у Cursor — не файл, а КАТАЛОГ `~/.cursor/rules/*.mdc`: каждое
 * правило едет своей записью со своим путём, поэтому `fileName` записи — это имя
 * файла правила, а не общее имя раздела. Права — ключ `permissions`
 * (`allow`/`deny`) в `cli-config.json`, без режима и без списка `ask`.
 *
 * Карта соответствий Cursor тоже есть у одностороннего импортёра самого Claude
 * Code (`.agent/cli-import-map.agent.md`) — следуем ей.
 */
export const importCursorEnvironment: Importer = (deps) => readUniversalSections(deps);
