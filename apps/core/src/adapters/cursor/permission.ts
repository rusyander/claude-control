import type { CoreToolClass, PermissionAsk, RawToolCall } from '../adapter.types.ts';
import { argvExact } from '../argv-exact.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов Cursor Agent поверх ACP — НЕ проверен на живом CLI (входа Cursor нет; этап 10,
 * пометка в отчёте): имена инструментов — те, что документация хуков Cursor называет в
 * `preToolUse.tool_name` (`Shell`, `Read`, `Write`, `Edit`, `Delete`, `Grep`, `Glob`, `WebFetch`,
 * `Task`). В ACP имя берётся из `kind` вызова (`execute` → `Shell`), вход — `rawInput`. Подставной
 * CLI (`__fixtures__/fake-cursor-agent.mjs`) говорит ровно этими словами; живой прогон обязан их
 * подтвердить, прежде чем переходник попадёт в реестр.
 */

const SHELL_TOOL = 'Shell';
const READ_TOOLS = new Set(['Read']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'Delete']);
const NET_TOOLS = new Set(['WebFetch']);

/** Встроенные инструменты Cursor по классам ядра (хук ядра судит по ним). */
export const CURSOR_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['Write'],
  edit: ['Edit', 'Write', 'Delete'],
  shell: [SHELL_TOOL],
  web: ['WebFetch'],
};

/** Имя инструмента по `kind` вызова ACP; прочее — `title`, иначе `unknown`. */
const KIND_TOOL: Record<string, string> = {
  execute: SHELL_TOOL,
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  search: 'Grep',
  fetch: 'WebFetch',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function cursorToolName(call: Record<string, unknown>): string {
  return KIND_TOOL[text(call.kind)] ?? (text(call.title) || 'unknown');
}

/** Оболочка Cursor — системная (sh, на Windows PowerShell): точен только текст без особых знаков. */
const exact = (command: string): boolean =>
  argvExact(command, 'system') && argvExact(command, 'powershell');

const pathOf = (input: Record<string, unknown>): string =>
  text(input.path) || text(input.file_path) || text(input.target_file);

export function mapCursorPermission(raw: RawToolCall): PermissionAsk {
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
    const target = pathOf(input);
    // Чтение без пути судья не решит — «другое» строже; поиск без пути — рабочая папка.
    if (!target && READ_TOOLS.has(tool))
      return { action: 'other', target: tool, tool, display: tool };
    return { action: 'read', target: target || '.', tool, display: `${tool} ${target}`.trim() };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = pathOf(input);
    if (!target) return { action: 'other', target: tool, tool, display: tool };
    return { action: 'edit', target, tool, display: `${tool} ${target}` };
  }
  if (NET_TOOLS.has(tool)) {
    const target = text(input.url);
    return { action: 'net', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (tool === 'Task') {
    const target = text(input.subagent_type);
    return { action: 'subagent', target, model: null, tool, display: `${tool} ${target}`.trim() };
  }
  return { action: 'other', target: tool, tool, display: tool };
}
