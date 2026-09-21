import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → OpenCode.
 *
 * Принимает скиллы (`skill-md-dir`), команды `commands/*.md` с шапкой, MCP
 * ключом `mcp`. Хуки — НЕ принимает: ключ `experimental.hook` исчез из
 * документации и схемы CLI, раздел переведён в чтение
 * (`hooksConfig.writeDisabledReason`), и приговор считает механизм
 * отсутствующим — писать ключ, которого нет в справочнике, панель не станет.
 *
 * Скиллы OpenCode читает ещё и из `~/.claude/skills` и `~/.agents/skills`:
 * лежащий там скилл копии не получает.
 */
export const emitToOpencode: Emitter = (env, deps) => emitUniversalSections(env, deps);
