import { isAbsolute, join, resolve } from 'node:path';
import type { CoreToolClass, DenySet, PermissionAsk, RawToolCall } from '../adapter.types.ts';
import { argvExact } from '../argv-exact.ts';
import { commandArgv } from '../shell-argv.ts';
import { claudePathPatterns } from './path-pattern.ts';

export { claudeAbsolutePattern, claudePathPatterns } from './path-pattern.ts';

/**
 * Права в словаре Claude Code: типизированный вопрос из сырого вызова инструмента и запреты
 * платформы в правилах `permissions.deny` / `--disallowedTools`. `exec` несёт разобранный argv
 * первой команды и всю строку в `display`: по тексту не запрещается ничего (06, P04), кроме
 * публикации — её судья ищет во всей строке (P28, `adapters/permit-road.test.ts`).
 */

const SEARCH_TOOLS = new Set(['Glob', 'Grep']);
const READ_TOOLS = new Set(['Read', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
/**
 * Только состояние разговора CLI: без `ToolSearch` CLI не загрузит отложенные инструменты ядра
 * (`mcp__agentdeck__step_done`), и шаг не закончится. `Skill` и `Task`/`Agent` действуют — у них
 * свои классы `skill` / `subagent`, судья пускает их только по фактам слоя сеанса (06:115, 06:124).
 */
const CONVERSATION_TOOLS = new Set(['ToolSearch', 'TodoWrite']);
/** Проба L Q5: на проводе подагент — `Agent`, в списке `init.tools` ещё `Task`. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Класс ядра → встроенные инструменты Claude Code. */
export const CLAUDE_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['Write'],
  edit: ['Edit', 'MultiEdit', 'NotebookEdit'],
  shell: ['Bash', 'PowerShell'],
  web: ['WebFetch', 'WebSearch'],
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Цель поиска — корень, который CLI обойдёт, с маской: Grep — `path` (без него cwd) и `glob`,
 * Glob — `path` и `pattern`. Регулярное выражение Grep — не путь: целью оно увело бы судью
 * внутрь копии, пока поиск идёт по предку дома ядра (как `searchTarget` Qwen, F-13).
 */
function searchTarget(tool: string, input: Record<string, unknown>): string {
  const root = text(input.path) || '.';
  const mask = tool === 'Glob' ? text(input.pattern) : text(input.glob);
  if (!mask) return root;
  return isAbsolute(mask) ? mask : join(root, mask);
}

const lineNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * Диапазон Read (этап 8): `offset` у Claude Code — номер первой строки с единицы (проба 2.1.310:
 * offset 10 → `startLine: 10`), он и есть канон ядра. Ни одного поля — файл целиком (CLI читает
 * до 2000 строк, дальше режет сам).
 */
export function claudeReadRange(input: Record<string, unknown>): PermissionAsk['range'] {
  const offset = lineNumber(input.offset);
  const limit = lineNumber(input.limit);
  return offset === null && limit === null ? null : { offset, limit };
}

export function mapClaudePermission(raw: RawToolCall): PermissionAsk {
  const input = raw.input;
  const tool = raw.tool;
  if (tool.startsWith('mcp__')) {
    return { action: 'mcp', target: tool, tool, display: tool };
  }
  if (SEARCH_TOOLS.has(tool)) {
    const target = searchTarget(tool, input);
    return { action: 'read', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (READ_TOOLS.has(tool)) {
    const target = text(input.file_path) || text(input.path);
    return {
      action: 'read',
      target,
      ...(tool === 'Read' ? { range: claudeReadRange(input) } : {}),
      tool,
      display: `${tool} ${target}`.trim(),
    };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = text(input.file_path) || text(input.notebook_path);
    return { action: 'edit', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = text(input.command);
    const argv = commandArgv(command);
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      // Точность argv — по оболочке инструмента (F-02, `argv-exact.ts`).
      argvExact: argvExact(command, tool === 'PowerShell' ? 'powershell' : 'bash'),
      tool,
      display: command,
    };
  }
  if (NET_TOOLS.has(tool)) {
    const target = text(input.url) || text(input.query);
    return { action: 'net', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (CONVERSATION_TOOLS.has(tool)) {
    return { action: 'conversation', target: tool, tool, display: tool };
  }
  if (tool === 'Skill') {
    const target = text(input.skill);
    return { action: 'skill', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (SUBAGENT_TOOLS.has(tool)) {
    // Модель вызова — псевдоним (`sonnet|opus|haiku|…`); нет — модель определения или сеанса.
    const target = text(input.subagent_type);
    const model = text(input.model) || null;
    return { action: 'subagent', target, model, tool, display: `${tool} ${target}`.trim() };
  }
  return { action: 'other', target: tool, tool, display: tool };
}

/**
 * Программы, после которых префикс правила ничего не ограничивает: дороги публикации (`git`,
 * `gh`, `glab`) и всё, что исполняет другую команду (оболочки, обёртки, интерпретаторы).
 */
const OPEN_ENDED = new Set([
  'git',
  'gh',
  'glab',
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
  'env',
  'sudo',
  'doas',
  'xargs',
  'nohup',
  'timeout',
  'nice',
  'ionice',
  'flock',
  'taskset',
  'exec',
  'eval',
  'command',
  'builtin',
  'busybox',
  'script',
  'watch',
  'start',
  'node',
  'npx',
  'bun',
  'deno',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'iex',
  'invoke-expression',
  'start-process',
]);

const SHELL_RULE = /^(Bash|PowerShell)(?:\((.*)\))?$/s;

/**
 * Разрешение человека на оболочку, которое сеанс ядра может взять (F-32). Правило `Bash` целиком,
 * `Bash(*)` или с открытой программой впереди (`Bash(git:*)`, `Bash(sh -c:*)`) отвечало бы «да»
 * раньше вопроса — судья ядра не увидел бы ни `git -C x push`, ни push внутри обёртки. Такое
 * правило не переносится: CLI спрашивает, отвечает судья (или отказ без него).
 */
export function keepHumanAllow(rule: string): boolean {
  const shell = SHELL_RULE.exec(rule.trim());
  if (!shell) return true;
  const body = (shell[2] ?? '').trim();
  if (body === '' || body.startsWith('*') || body.startsWith(':')) return false;
  const first = (body.split(/[\s:]/)[0] ?? '').toLowerCase();
  if (first.includes('*') || first.includes('/') || first.includes('\\')) return false;
  return !OPEN_ENDED.has(first.replace(/\.[a-z0-9]+$/, ''));
}

export function claudeDenyRules(
  deny: DenySet,
  extraTools: readonly CoreToolClass[],
  cwd: string,
): {
  rules: string[];
  disallowed: string[];
} {
  const rules: string[] = [];
  // Относительный путь запрета — от cwd сеанса, как его понимает Qwen (F-36); без этого он
  // становился бы путём от корня ФС и не совпадал ни с чем.
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));
  for (const path of deny.paths) {
    // Сам путь (файл токена) и всё под ним (дом ядра); `Edit` покрывает и запись.
    for (const pattern of claudePathPatterns(absolute(path))) {
      for (const tool of ['Read', 'Edit'])
        rules.push(`${tool}(${pattern})`, `${tool}(${pattern}/**)`);
    }
  }
  for (const path of deny.editPaths ?? []) {
    for (const pattern of claudePathPatterns(absolute(path))) {
      rules.push(`Edit(${pattern})`, `Edit(${pattern}/**)`);
    }
  }
  // Префикс argv запрещается КАЖДОМУ инструменту оболочки: `PowerShell(git push:*)` CLI
  // соблюдает, а без него PowerShell исполнял push при разрешённом инструменте (verify-cli V1).
  for (const argv of deny.commands) {
    for (const tool of CLAUDE_TOOL_NAMES.shell) rules.push(`${tool}(${argv.join(' ')}:*)`);
  }
  rules.push(...deny.mcpTools);
  const classes = [...new Set([...deny.tools, ...extraTools])];
  const disallowed = classes.flatMap((c) => CLAUDE_TOOL_NAMES[c]);
  rules.push(...disallowed);
  return { rules: [...new Set(rules)], disallowed: [...disallowed, ...deny.mcpTools] };
}
