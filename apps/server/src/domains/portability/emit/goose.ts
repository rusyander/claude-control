import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Goose.
 *
 * MCP у Goose — отображение `extensions` в `config.yaml`. Прав правилами он не
 * знает вовсе: решение одно на весь CLI (`GOOSE_MODE`), поэтому отдельное
 * правило записать некуда — это говорит приговор, а не ветка здесь.
 */
export const emitToGoose: Emitter = (env, deps) => emitUniversalSections(env, deps);
