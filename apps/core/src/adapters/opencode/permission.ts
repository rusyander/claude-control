import { currentOs } from '../../platform/os-kind.ts';
import { argvExact, type ShellDialect } from '../argv-exact.ts';
import type { PermissionAsk, PermitCodec, RawToolCall } from '../adapter.types.ts';
import { SDK_PERMIT_CODEC } from '../sdk-stream/permit-codec.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов opencode 1.18 (живые пробы 02.11): плагин `tool.execute.before` получает
 * `input.tool` (`bash`, `edit`, `write`, `read`, …) и `output.args`; тот же вызов в ACP — `title`
 * первого события `tool_call`. Команду `bash` opencode на Windows исполняет через PowerShell
 * (`$env:…` раскрывается, `%…%` — нет), иначе — bash.
 */

export const OPENCODE_SHELL: ShellDialect = currentOs() === 'win32' ? 'powershell' : 'bash';

const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit']);
const LIST_TOOLS = new Set(['glob', 'grep', 'list']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function mapOpencodePermission(raw: RawToolCall): PermissionAsk {
  const { tool, input } = raw;
  if (tool === 'bash') {
    const command = text(input.command);
    const argv = commandArgv(command);
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      argvExact: argvExact(command, OPENCODE_SHELL),
      tool,
      display: command,
    };
  }
  const path = text(input.filePath) || text(input.path);
  if (EDIT_TOOLS.has(tool)) {
    // Правка без пути (патч на несколько файлов) судье не разобрать: «другое» строже.
    if (!text(input.filePath)) return { action: 'other', target: tool, tool, display: tool };
    return { action: 'edit', target: path, tool, display: `${tool} ${path}` };
  }
  if (tool === 'read') {
    return {
      action: 'read',
      target: path,
      range:
        count(input.offset) === null && count(input.limit) === null
          ? null
          : { offset: count(input.offset), limit: count(input.limit) },
      tool,
      display: `${tool} ${path}`,
    };
  }
  if (LIST_TOOLS.has(tool)) {
    return { action: 'read', target: path || '.', tool, display: `${tool} ${path || '.'}`.trim() };
  }
  if (tool === 'webfetch') {
    const url = text(input.url);
    return { action: 'net', target: url, tool, display: `${tool} ${url}` };
  }
  if (tool === 'task') {
    const kind = text(input.subagent_type) || 'general';
    return { action: 'subagent', target: kind, model: null, tool, display: `${tool} ${kind}` };
  }
  if (tool === 'skill') {
    const name = text(input.name);
    return { action: 'skill', target: name, tool, display: `${tool} ${name}` };
  }
  return { action: 'other', target: tool, tool, display: tool };
}

/** Ответ ядра `{decision}`; диалект ACP переводит его в вариант `allow_once`/`reject_once`. */
export const OPENCODE_PERMIT_CODEC: PermitCodec = {
  read: SDK_PERMIT_CODEC.read,
  render: (answer) => ({ decision: answer.allow ? 'accept' : 'decline' }),
};

/** Имя вызова ACP: `title` первого события (`bash`); позже opencode пишет туда команду. */
export function opencodeToolName(call: Record<string, unknown>): string {
  return text(call.title) || 'unknown';
}
