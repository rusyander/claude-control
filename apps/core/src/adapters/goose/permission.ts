import { argvExact, type ShellDialect } from '../argv-exact.ts';
import type { PermissionAsk, PermitCodec, RawToolCall } from '../adapter.types.ts';
import { SDK_PERMIT_CODEC } from '../sdk-stream/permit-codec.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Словарь вызовов Goose 1.54 (живые пробы 02.11): хук плагина получает `tool_name` без имени
 * расширения (`shell`, `text_editor`) и вход как есть (`tool_input.command`); тот же вызов в ACP —
 * `_meta.goose.toolCall.toolName`. Команду `shell` Goose на Windows исполняет через cmd
 * (`%ComSpec%` раскрывается), иначе — оболочкой системы: точность argv — по диалекту `system`.
 */

const SHELL_TOOL = 'shell';
const EDITOR_TOOL = 'text_editor';
const READ_COMMANDS = new Set(['view']);

export const GOOSE_SHELL: ShellDialect = 'system';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function mapGoosePermission(raw: RawToolCall): PermissionAsk {
  const { tool, input } = raw;
  if (tool === SHELL_TOOL) {
    const command = text(input.command);
    const argv = commandArgv(command);
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      argvExact: argvExact(command, GOOSE_SHELL),
      tool,
      display: command,
    };
  }
  if (tool === EDITOR_TOOL) {
    const path = text(input.path);
    const read = READ_COMMANDS.has(text(input.command));
    // Без пути судья не решит, что правится: «другое» строже.
    if (!path) return { action: 'other', target: tool, tool, display: tool };
    return { action: read ? 'read' : 'edit', target: path, tool, display: `${tool} ${path}` };
  }
  return { action: 'other', target: tool, tool, display: tool };
}

/**
 * Вопрос о праве диалект ACP отдаёт формой `{tool_name, input, tool_use_id}` (чтение — общее с
 * каркасом SDK); ответ — `{decision}`, диалект переводит его в вариант `allow_once`/`reject_once`.
 */
export const GOOSE_PERMIT_CODEC: PermitCodec = {
  read: SDK_PERMIT_CODEC.read,
  render: (answer) => ({ decision: answer.allow ? 'accept' : 'decline' }),
};

/** Имя вызова ACP так, как его видит хук плагина: `_meta.goose.toolCall.toolName`. */
export function gooseToolName(call: Record<string, unknown>): string {
  const meta = call._meta as { goose?: { toolCall?: { toolName?: unknown } } } | undefined;
  const name = meta?.goose?.toolCall?.toolName;
  if (typeof name === 'string' && name !== '') return name;
  const title = text(call.title);
  return title.split(' · ')[0] || 'unknown';
}
