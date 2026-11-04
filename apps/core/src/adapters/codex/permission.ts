import { currentOs } from '../../platform/os-kind.ts';
import { argvExact, type ShellDialect } from '../argv-exact.ts';
import type { PermissionAsk, PermitCodec, RawToolCall } from '../adapter.types.ts';
import { SDK_PERMIT_CODEC } from '../sdk-stream/permit-codec.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов Codex (codex-cli 0.155.1, живые пробы 02.11): хук `PreToolUse` получает
 * `tool_name: "Bash"` и внутреннюю команду в `tool_input.command`; запрос права
 * `item/commandExecution/requestApproval` несёт ту же команду, обёрнутую оболочкой
 * (`"…\pwsh.exe" -Command '…'` на Windows). Судья читает внутреннюю команду целиком — не
 * `commandActions[0]`: составная команда спрятала бы `git push` во втором звене.
 */

const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'unified_exec']);
const PATCH_TOOL = 'apply_patch';
const SHELL_IMAGE = /(?:^|[\\/])(?:pwsh|powershell|bash|sh|zsh|dash)(?:\.exe)?$/i;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Оболочка, которой Codex исполняет команды на этой платформе. */
export const CODEX_SHELL: ShellDialect = currentOs() === 'win32' ? 'powershell' : 'bash';

/**
 * Снять обёртку оболочки (`<shell> -Command '<cmd>'`, `<shell> -lc '<cmd>'`). Строка без обёртки
 * возвращается как есть (точна); обёртка, чью кавычку разбор не повторяет дословно, —
 * `exact: false`, и судья argv не верит.
 */
export function unwrapCodexShell(command: string): { inner: string; exact: boolean } {
  const m = /^("[^"]*"|\S+)\s+(-Command|-c|-lc)\s+([\s\S]+)$/.exec(command.trim());
  if (!m) return { inner: command, exact: true };
  const image = (m[1] as string).replace(/^"|"$/g, '');
  if (!SHELL_IMAGE.test(image)) return { inner: command, exact: true };
  const body = m[3] as string;
  // PowerShell: в одинарных кавычках единственный экран — удвоенная кавычка.
  const pwsh = /^'((?:[^']|'')*)'$/.exec(body);
  if (pwsh && /pwsh|powershell/i.test(image)) {
    return { inner: (pwsh[1] as string).replace(/''/g, "'"), exact: true };
  }
  // POSIX-оболочка: одинарные кавычки без экранов внутри — текст дословно.
  const posix = /^'([^']*)'$/.exec(body);
  if (posix) return { inner: posix[1] as string, exact: true };
  return { inner: body.replace(/^['"]|['"]$/g, ''), exact: false };
}

export function mapCodexPermission(raw: RawToolCall): PermissionAsk {
  const { tool, input } = raw;
  if (SHELL_TOOLS.has(tool)) {
    const command = text(input.command) || text(input.cmd);
    const { inner, exact } = unwrapCodexShell(command);
    const argv = commandArgv(inner);
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      argvExact: exact && argvExact(inner, CODEX_SHELL),
      tool,
      display: inner,
    };
  }
  if (tool === PATCH_TOOL) {
    const changes = Array.isArray(input.changes) ? (input.changes as unknown[]) : [];
    const paths = changes
      .map((c) => (typeof c === 'object' && c !== null ? text((c as { path?: unknown }).path) : ''))
      .filter(Boolean);
    // Одна правка — путь судье; несколько путей одной строкой судья не разберёт: «другое» строже.
    if (paths.length === 1 && changes.length === 1) {
      return { action: 'edit', target: paths[0] as string, tool, display: `${tool} ${paths[0]}` };
    }
    return { action: 'other', target: tool, tool, display: `${tool} ${paths.join(', ')}`.trim() };
  }
  if (tool.startsWith('mcp__')) {
    return { action: 'mcp', target: tool, tool, display: tool };
  }
  return { action: 'other', target: tool, tool, display: tool };
}

/**
 * Вопрос о праве приходит от диалекта уже в форме `{tool_name, input, tool_use_id}` (чтение —
 * общее с каркасом SDK); ответ — решение Codex: `accept` исполняет вызов как есть, `decline`
 * отказывает. Правку входа Codex не принимает, поэтому разрешение не несёт `updatedInput`.
 */
export const CODEX_PERMIT_CODEC: PermitCodec = {
  read: SDK_PERMIT_CODEC.read,
  render: (answer) => ({ decision: answer.allow ? 'accept' : 'decline' }),
};

/** Ответ, который Codex исполнит: только целое `accept`/`decline`; всё прочее — отказ. */
export function codexDecision(reply: unknown): 'accept' | 'decline' {
  const decision =
    typeof reply === 'object' && reply !== null ? (reply as { decision?: unknown }).decision : null;
  return decision === 'accept' ? 'accept' : 'decline';
}
