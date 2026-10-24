import type { LiveShellCall } from './types.ts';

/**
 * Команда оболочки из просьбы о разрешении чужого CLI — ровно то, что пришло по
 * проводу (живые пробы 24.10 на заглушке модели, `provider-formats-live.agent.md`):
 * - codex 0.155 app-server: `item/commandExecution/requestApproval.params.command` —
 *   вся строка запуска, `"<…\pwsh.exe>" -Command '<команда>'` на Windows,
 *   `/bin/bash -lc '<команда>'` на POSIX; каталог — `params.cwd`;
 * - qwen 0.24 serve: `toolCall._meta.toolName === 'run_shell_command'`,
 *   `toolCall.rawInput.{command,directory}`;
 * - goose 1.54 acp (режим `approve`): `toolCall.rawInput.command`, заголовок
 *   `shell · <команда>`;
 * - opencode serve: просьба `permission === 'bash'`, команды — `patterns`.
 * Обёртку не узнали — строка как есть, оболочка `unknown`: судья прочтёт её обоими
 * чтениями, строжайшее побеждает.
 */

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Первое слово строки: в двойных кавычках (путь с пробелами) или до пробела. */
function firstWord(line: string): { word: string; rest: string } {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return { word: trimmed.slice(1, end), rest: trimmed.slice(end + 1) };
  }
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  return { word: match?.[1] ?? '', rest: match?.[2] ?? '' };
}

/** Имя программы без пути и `.exe`, в нижнем регистре. */
const program = (word: string): string =>
  (word.split(/[/\\]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();

/** Снять внешние кавычки аргумента: PowerShell `'…'` (`''` → `'`), POSIX `'…'` (`'\''`). */
function unquote(arg: string, kind: 'powershell' | 'bash' | 'cmd'): string {
  const value = arg.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    return kind === 'powershell' ? inner.replace(/''/g, "'") : inner.replace(/'\\''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Строка запуска оболочки → команда и оболочка. `pwsh|powershell -Command X`,
 * `bash|sh|zsh -c|-lc X`, `cmd /c X`; иначе — как есть, `unknown`.
 */
export function unwrapShellLine(line: string): Pick<LiveShellCall, 'command' | 'shell'> {
  const { word, rest } = firstWord(line);
  const name = program(word);
  if (name === 'pwsh' || name === 'powershell') {
    const at = /(?:^|\s)-(?:command|c)\s+([\s\S]*)$/i.exec(rest);
    if (at?.[1] !== undefined)
      return { command: unquote(at[1], 'powershell'), shell: 'powershell' };
  }
  if (name === 'bash' || name === 'sh' || name === 'zsh') {
    const at = /(?:^|\s)-[a-z]*c\s+([\s\S]*)$/i.exec(rest);
    if (at?.[1] !== undefined) return { command: unquote(at[1], 'bash'), shell: 'bash' };
  }
  if (name === 'cmd') {
    const at = /(?:^|\s)\/[ck]\s+([\s\S]*)$/i.exec(rest);
    if (at?.[1] !== undefined) return { command: unquote(at[1], 'cmd'), shell: 'cmd' };
  }
  return { command: line, shell: 'unknown' };
}

/** Программа оболочки → чем она читает команду. */
const SHELL_PROGRAMS: Partial<Record<string, 'powershell' | 'bash' | 'cmd'>> = {
  pwsh: 'powershell',
  powershell: 'powershell',
  bash: 'bash',
  sh: 'bash',
  zsh: 'bash',
  cmd: 'cmd',
};

/** codex: `params.command` строкой (app-server) или списком (старый `execCommandApproval`). */
export function codexShellAsk(params: Record<string, unknown>): LiveShellCall | undefined {
  const raw = params.command;
  const line = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === 'string')
    : undefined;
  const cwd = text(params.cwd);
  if (line && line.length > 0) {
    // Список: `["pwsh", "-Command", "<команда>"]`, `["bash", "-lc", "<команда>"]`.
    const name = program(line[0] ?? '');
    const last = line[line.length - 1] ?? '';
    const shell = SHELL_PROGRAMS[name];
    const call: Pick<LiveShellCall, 'command' | 'shell'> =
      shell && line.length >= 3
        ? { command: last, shell }
        : { command: line.join(' '), shell: 'unknown' };
    return { ...call, ...(cwd ? { cwd } : {}) };
  }
  const command = text(raw);
  if (!command) return undefined;
  return { ...unwrapShellLine(command), ...(cwd ? { cwd } : {}) };
}

/** Оболочка CLI без своей обёртки на проводе: на Windows не названа. */
const hostShell = (platform: NodeJS.Platform): LiveShellCall['shell'] =>
  platform === 'win32' ? 'unknown' : 'bash';

/** qwen serve: только `run_shell_command`; правки файлов — не команда. */
export function qwenShellAsk(
  toolCall: unknown,
  platform: NodeJS.Platform = process.platform,
): LiveShellCall | undefined {
  const call = (toolCall ?? {}) as {
    _meta?: { toolName?: unknown };
    rawInput?: { command?: unknown; directory?: unknown };
  };
  if (call._meta?.toolName !== 'run_shell_command') return undefined;
  const command = text(call.rawInput?.command);
  if (!command) return undefined;
  const cwd = text(call.rawInput?.directory);
  return { command, shell: hostShell(platform), ...(cwd ? { cwd } : {}) };
}

/** goose acp: инструмент `shell` расширения developer (`rawInput.command`). */
export function gooseShellAsk(
  toolCall: unknown,
  platform: NodeJS.Platform = process.platform,
): LiveShellCall | undefined {
  const call = (toolCall ?? {}) as { title?: unknown; rawInput?: { command?: unknown } };
  const command = text(call.rawInput?.command);
  if (!command) return undefined;
  const title = typeof call.title === 'string' ? call.title : '';
  // Команду несёт только инструмент оболочки; у прочих `command` — не строка запуска.
  if (title && !/^(?:developer__)?shell\b/i.test(title)) return undefined;
  return { command, shell: hostShell(platform) };
}

/** opencode serve: просьба `bash`, команды — `patterns` (по одной на звено). */
export function opencodeShellAsk(
  ask: { permission?: unknown; patterns?: unknown },
  platform: NodeJS.Platform = process.platform,
): LiveShellCall | undefined {
  if (ask.permission !== 'bash' || !Array.isArray(ask.patterns)) return undefined;
  const lines = ask.patterns.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  if (lines.length === 0) return undefined;
  return { command: lines.join('\n'), shell: hostShell(platform) };
}
