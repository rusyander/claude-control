import { readUniversalSections } from '../sections.ts';
import type { Importer } from '../types.ts';

/**
 * Gemini CLI → канон.
 *
 * Разделы: `GEMINI.md`, `settings.json` (MCP, права `defaultApprovalMode` +
 * `coreTools`/`excludeTools`), файл `.env`, каталог `commands/*.toml`. Скиллов,
 * хуков и плагинов у Gemini нет.
 *
 * Как и у Codex, карта соответствий взята у одностороннего импортёра самого
 * Claude Code (`.agent/cli-import-map.agent.md`): расхождение с ней — падение
 * теста, а не «наша трактовка».
 */
export const importGeminiEnvironment: Importer = (deps) => readUniversalSections(deps);
