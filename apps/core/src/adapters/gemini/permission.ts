import { acpPathOf } from '../acp-input.ts';
import type { CoreToolClass, PermissionAsk, RawToolCall } from '../adapter.types.ts';
import { argvExact } from '../argv-exact.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов Gemini CLI 0.66 под `--acp` (живые пробы 02.11, бандл 0.66): имя инструмента —
 * приставка `toolCallId` до `__` (`run_shell_command__call_…`); `rawInput` CLI не шлёт. Вход
 * восстанавливается из строки: команда оболочки — `title` (`getDisplayTitle()` = `params.command`
 * дословно), путь файла — `content[{type:'diff', path}]` или `locations[{path}]` (абсолютные).
 * Аргументы модели: `read_file/write_file/replace(file_path)`, `list_directory/glob/
 * grep_search(dir_path)`, `run_shell_command(command)`, `web_fetch(prompt)`,
 * `google_web_search(query)`.
 */

const SHELL_TOOL = 'run_shell_command';
const READ_TOOLS = new Set(['read_file']);
const DIR_TOOLS = new Set(['list_directory', 'glob', 'grep_search']);
const EDIT_TOOLS = new Set(['write_file', 'replace']);
const NET_TOOLS: Record<string, string> = { web_fetch: 'prompt', google_web_search: 'query' };
const CONVERSATION_TOOLS = new Set(['write_todos', 'update_topic', 'enter_plan_mode']);

/** Встроенные инструменты Gemini по классам ядра — оверлей запретов (`policy.ts`). */
export const GEMINI_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['write_file'],
  edit: ['replace', 'write_file'],
  shell: [SHELL_TOOL],
  web: ['web_fetch', 'google_web_search'],
};

/** Инструменты с путём: аргумент пути у каждого (оверлей запретов путей). */
export const GEMINI_PATH_ARGS: Record<string, string> = {
  read_file: 'file_path',
  write_file: 'file_path',
  replace: 'file_path',
  list_directory: 'dir_path',
  glob: 'dir_path',
  grep_search: 'dir_path',
};

/** Shell Gemini: PowerShell на Windows, bash иначе — точен только текст без особых знаков обеих. */
const exact = (command: string): boolean =>
  argvExact(command, 'system') && argvExact(command, 'powershell');

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function geminiToolName(call: Record<string, unknown>): string {
  const id = text(call.toolCallId);
  const at = id.indexOf('__');
  if (at > 0) return id.slice(0, at);
  return 'unknown';
}

/** Вход вызова из строки ACP: Gemini `rawInput` не шлёт (см. шапку). */
export function fillGeminiInput(call: Record<string, unknown>): Record<string, unknown> | null {
  const tool = geminiToolName(call);
  const title = text(call.title);
  if (tool === SHELL_TOOL) return title ? { command: title } : null;
  const pathArg = GEMINI_PATH_ARGS[tool];
  if (pathArg) {
    const path = acpPathOf(call);
    return path ? { [pathArg]: path } : null;
  }
  const netArg = NET_TOOLS[tool];
  if (netArg) return title ? { [netArg]: title } : null;
  return null;
}

export function mapGeminiPermission(raw: RawToolCall): PermissionAsk {
  const { tool, input } = raw;
  if (tool === SHELL_TOOL) {
    const command = text(input.command);
    const argv = commandArgv(command);
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      argvExact: exact(command),
      tool,
      display: command,
    };
  }
  if (READ_TOOLS.has(tool) || DIR_TOOLS.has(tool)) {
    const target = text(input.file_path) || text(input.dir_path);
    // Без пути судья не решит, что читается: «другое» строже.
    if (!target) return { action: 'other', target: tool, tool, display: tool };
    return { action: 'read', target, tool, display: `${tool} ${target}` };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = text(input.file_path);
    if (!target) return { action: 'other', target: tool, tool, display: tool };
    return { action: 'edit', target, tool, display: `${tool} ${target}` };
  }
  const netArg = NET_TOOLS[tool];
  if (netArg) {
    const target = text(input[netArg]);
    return { action: 'net', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (CONVERSATION_TOOLS.has(tool)) {
    return { action: 'conversation', target: tool, tool, display: tool };
  }
  return { action: 'other', target: tool, tool, display: tool };
}
