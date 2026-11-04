import { acpContentText } from '../acp-input.ts';
import type { CoreToolClass, PermissionAsk, RawToolCall } from '../adapter.types.ts';
import { argvExact } from '../argv-exact.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов Kimi Code 2.4.1 (живые пробы 02.11 на stub-model): имя инструмента — `title`
 * первого `tool_call` (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `FetchURL`, `Agent`,
 * `Skill`, …), хук `PreToolUse` получает то же имя и вход формы Claude (`tool_input`). Вход в ACP
 * приходит текстом JSON в `content` первого `tool_call_update`; `rawInput` — только после
 * одобрения, а вопрос о праве входа не несёт. Аргументы: `Bash(command, cwd)`, `Read/Write/Edit/
 * ReadMediaFile(path)`, `Glob/Grep(pattern, path)`, `FetchURL(url)`.
 */

const SHELL_TOOL = 'Bash';
const READ_TOOLS = new Set(['Read', 'ReadMediaFile']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep']);
const EDIT_TOOLS = new Set(['Write', 'Edit']);
const NET_TOOLS = new Set(['FetchURL']);
const SUBAGENT_TOOLS = new Set(['Agent', 'AgentSwarm']);
const CONVERSATION_TOOLS = new Set(['TodoList', 'AskUserQuestion', 'ExitPlanMode']);

/** Встроенные инструменты Kimi по классам ядра (хук ядра судит по ним). */
export const KIMI_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['Write'],
  edit: ['Edit', 'Write'],
  shell: [SHELL_TOOL],
  web: ['FetchURL'],
};

/** Bash Kimi: bash на Linux и macOS, PowerShell на Windows — точен только текст без особых знаков. */
const exact = (command: string): boolean =>
  argvExact(command, 'system') && argvExact(command, 'powershell');

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function kimiToolName(call: Record<string, unknown>): string {
  return text(call.title) || 'unknown';
}

/**
 * Вход из `content` вызова, пока он не завершён: у завершённого там вывод инструмента, и вывод
 * в форме JSON (`cat x.json`) не должен стать входом.
 */
export function fillKimiInput(call: Record<string, unknown>): Record<string, unknown> | null {
  if (call.status === 'completed' || call.status === 'failed') return null;
  const body = acpContentText(call).trim();
  if (!body.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function mapKimiPermission(raw: RawToolCall): PermissionAsk {
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
  if (READ_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)) {
    const target = text(input.path);
    // Поиск без пути — рабочая папка CLI; чтение без пути судья не решит — «другое» строже.
    if (!target && READ_TOOLS.has(tool))
      return { action: 'other', target: tool, tool, display: tool };
    return { action: 'read', target: target || '.', tool, display: `${tool} ${target}`.trim() };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = text(input.path);
    if (!target) return { action: 'other', target: tool, tool, display: tool };
    return { action: 'edit', target, tool, display: `${tool} ${target}` };
  }
  if (NET_TOOLS.has(tool)) {
    const target = text(input.url);
    return { action: 'net', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (tool === 'Skill') {
    const target = text(input.skill);
    return { action: 'skill', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (SUBAGENT_TOOLS.has(tool)) {
    const target = text(input.subagent_type);
    return { action: 'subagent', target, model: null, tool, display: `${tool} ${target}`.trim() };
  }
  if (CONVERSATION_TOOLS.has(tool)) {
    return { action: 'conversation', target: tool, tool, display: tool };
  }
  return { action: 'other', target: tool, tool, display: tool };
}
