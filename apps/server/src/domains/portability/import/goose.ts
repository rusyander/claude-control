import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Goose → канон.
 *
 * Разделы: `.goosehints` как инструкции, `config.yaml` (MCP-расширения, режим
 * и `tool_permissions`). Своего места для переменных окружения у Goose нет,
 * скиллов, хуков и плагинов тоже — все эти разделы приходят пропуском с
 * причиной «этого раздела нет», а не пустым списком.
 */
export const importGooseEnvironment: Importer = (deps) => readUniversalSections(deps);
