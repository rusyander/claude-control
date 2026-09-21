import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Gemini CLI.
 *
 * Принимает `~/.gemini/GEMINI.md`, `settings.json` (MCP объектом `mcpServers`),
 * `.env` (переменные), каталог `commands/` файлами `.toml` с обязательным
 * ключом `prompt`. Подкаталог команды даёт пространство имён `/dir:name` —
 * разделитель берётся из каталога возможностей, а не подразумевается.
 */
export const emitToGemini: Emitter = (env, deps) => emitUniversalSections(env, deps);
