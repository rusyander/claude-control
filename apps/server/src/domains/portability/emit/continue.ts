import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Continue.
 *
 * Глобального файла инструкций у Continue нет — есть каталог правил, и записи
 * едут в него. MCP лежит СПИСКОМ `mcpServers`, где имя записи внутри неё самой;
 * этим занимается адаптер формата, а не эмиттер.
 */
export const emitToContinue: Emitter = (env, deps) => emitUniversalSections(env, deps);
