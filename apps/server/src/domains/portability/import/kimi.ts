import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Kimi CLI → канон.
 *
 * Разделы: `AGENTS.md`, `config.toml` (MCP, права, хуки `[[hooks]]`), каталог
 * `skills/`, список установленных плагинов.
 *
 * ДВА СВОЙСТВА, которые обязаны доехать. Порядок прав у Kimi ЗНАЧИМ — канон
 * везёт его полем `order` и не пересортировывает. Раздел плагинов у Kimi
 * read-only: состоянием владеет его собственная команда `/plugins`, и запись
 * канона несёт это фактом (`readOnly`), а не молчанием.
 */
export const importKimiEnvironment: Importer = (deps) => readUniversalSections(deps);
