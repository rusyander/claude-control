import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Qwen Code → канон.
 *
 * Разделы: `QWEN.md`, `settings.json` (MCP, права, хуки), `.env`, каталоги
 * `skills/` и `commands/*.toml`.
 *
 * ТАЙМАУТ ХУКА У QWEN — В МИЛЛИСЕКУНДАХ. Единица едет вместе со значением
 * (`readProviderHooksInfo` отдаёт её, `normalizeHooks` записывает в канон):
 * «60» без единицы — это либо минута, либо шестнадцать часов.
 */
export const importQwenEnvironment: Importer = (deps) => readUniversalSections(deps);
