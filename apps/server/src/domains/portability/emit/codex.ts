import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Codex.
 *
 * Принимает `~/.codex/AGENTS.md` (инструкции), `config.toml` (MCP таблицами
 * `[mcp_servers.<имя>]`, переменные `[shell_environment_policy.set]`). Скиллов,
 * команд и хуков у Codex нет вовсе — приговор уводит их в эмуляцию или в текст
 * инструкций, и ни одной записи в чужой конфиг при этом не появляется.
 */
export const emitToCodex: Emitter = (env, deps) => emitUniversalSections(env, deps);
