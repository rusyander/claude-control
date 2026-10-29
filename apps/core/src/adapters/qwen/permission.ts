import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { CoreToolClass, DenySet, PermissionAsk, RawToolCall } from '../adapter.types.ts';
import { argvExact } from '../argv-exact.ts';
import { caselessGlob, localShareHosts } from '../local-share.ts';
import { commandArgv } from '../shell-argv.ts';

/**
 * Права в словаре Qwen Code: типизированный вопрос из сырого вызова и запреты платформы в
 * правилах `permissions.deny` системных настроек / `--exclude-tools`. Имена инструментов —
 * канонические имена CLI (`run_shell_command`, `read_file`, `edit`…). Правило `read_file(...)`
 * покрывает `zoom_image`/`grep_search`/`glob`/`list_directory`, `edit(...)` — `write_file`/
 * `notebook_edit`, `run_shell_command(...)` — `monitor` (Qwen Code 0.24.3,
 * `toolMatchesRuleToolName`, F-40/F-39). Путь поиска CLI сверяет по параметру `path` (корень), а
 * без него — ни с чем: поэтому правила — первый замок, второй — хук ядра (без него сеанс не идёт).
 */

const READ_TOOLS = new Set(['read_file', 'zoom_image']);
const SEARCH_TOOLS = new Set(['grep_search', 'glob', 'list_directory']);
const EDIT_TOOLS = new Set(['edit', 'write_file', 'notebook_edit']);
const SHELL_TOOLS = new Set(['run_shell_command', 'monitor']);
const NET_TOOLS = new Set(['web_fetch', 'web_search']);
/**
 * Только состояние разговора CLI (Qwen Code 0.24.3 `ToolNames`): `tool_search` грузит отложенные
 * инструменты (ядра тоже), `todo_write` ведёт список дел сеанса. `agent`/`skill`/`tool_call`
 * действуют — `other`.
 */
const CONVERSATION_TOOLS = new Set(['tool_search', 'todo_write']);

/** Класс ядра → встроенные инструменты Qwen Code. */
export const QWEN_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['write_file'],
  edit: ['edit', 'notebook_edit'],
  shell: ['run_shell_command', 'monitor'],
  web: ['web_fetch', 'web_search'],
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Цель поиска для судьи — КОРЕНЬ поиска, а не регулярное выражение (F-13): `path` (нет — рабочий
 * каталог, `.`), маска (`glob.pattern`, `grep_search.glob`) — от корня: `../../**` поднимает корень.
 * Судья берёт буквальную голову цели и отказывает корню-предку дома ядра.
 */
function searchTarget(tool: string, input: Record<string, unknown>): string {
  const root = text(input.path) || '.';
  const mask = tool === 'glob' ? text(input.pattern) : text(input.glob) || text(input.include);
  if (!mask) return root;
  return isAbsolute(mask) ? mask : join(root, mask);
}

export function mapQwenPermission(raw: RawToolCall): PermissionAsk {
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
    return { action: 'read', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = text(input.file_path) || text(input.notebook_path);
    return { action: 'edit', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = text(input.command);
    const argv = commandArgv(command);
    // Оболочка Qwen — оболочка системы (cmd на Windows, sh иначе): точен только текст без
    // особых знаков обеих (F-02).
    return {
      action: 'exec',
      target: argv[0] ?? '',
      argv,
      argvExact: argvExact(command, 'system'),
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
  return { action: 'other', target: tool, tool, display: tool };
}

/** Знаки маски picomatch и переводы строк: CLI сверяет правило маской (F-39). */
const GLOB_META = /[*?[\]{}()!\r\n]/;

/**
 * Путь в правиле Qwen Code — от рабочего каталога сеанса. Форма `//абсолютный` у CLI
 * превращается в `/C:/…` и на Windows не совпадает ни с одним путём; относительная форма
 * (`../..`) сравнивается верно везде. Путь на другом диске относительным не выражается —
 * такое правило не пишется, этот путь стережёт хук ядра (`null`, остаток в отчёте). Знак маски
 * в пути или в cwd (CLI склеивает их в одну маску) — то же: правило не совпало бы с самим путём.
 */
export function qwenPathPattern(cwd: string, path: string): string | null {
  if (GLOB_META.test(path) || GLOB_META.test(cwd)) return null;
  const rel = relative(cwd, path).replace(/\\/g, '/');
  if (rel === '') return '.';
  // Другой корень: `relative` вернул абсолютный путь — правило с ним CLI склеит с cwd.
  if (/^([A-Za-z]:)?\//.test(rel)) return null;
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/s;

/**
 * Длинная форма пути (8.3 и регистр — как на диске) по ближайшему существующему предку, как
 * CLI сводит путь модели (`realpathNearestExisting`); недостающие сегменты — как даны.
 */
function longForm(path: string): string {
  const missing: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    // Путь диска на POSIX — не путь этой ФС: как дан (иначе `dirname` дошёл бы до `.`).
    if (!isAbsolute(at)) return path;
    try {
      return join(realpathSync.native(at), ...missing);
    } catch {
      if (dirname(at) === at) return path;
      missing.unshift(basename(at));
    }
  }
}

/**
 * Тот же путь диска через административную долю этой машины (`\\localhost\C$\…`, `\\?\UNC\…`,
 * core-s2 F-126). Qwen сверяет правило с путём модели и с его realpath; регистр, 8.3, `\\?\C:\` и
 * `\\.\C:\` realpath сводит к длинной форме диска, а доля остаётся долей (живая проба Q1 на
 * matchesRule самого CLI) — относительное правило её не берёт. Правило `//…` у CLI — путь от корня
 * (`///host/C$/x` = `//host/C$/x`); регистр — классами, CLI сверяет с учётом регистра. Путь со
 * знаком маски — без формы, как в `qwenPathPattern`.
 */
export function qwenSharePatterns(path: string): string[] {
  if (!DRIVE_PATH.test(path) || GLOB_META.test(path)) return [];
  const drive = DRIVE_PATH.exec(longForm(path));
  if (!drive) return [];
  const letter = drive[1] as string;
  const rest = (drive[2] as string).replace(/\\/g, '/').replace(/\/+$/, '');
  if (GLOB_META.test(rest)) return [];
  const tail = rest === '' ? '' : `/${caselessGlob(rest)}`;
  return localShareHosts().map(
    (host) => `///${caselessGlob(host)}/${caselessGlob(letter)}$${tail}`,
  );
}

/** Каталоги-предки пути до корня ФС (без самого пути). */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let at = dirname(path); ; at = dirname(at)) {
    out.push(at);
    if (dirname(at) === at) return out;
  }
}

export function qwenDenyRules(
  deny: DenySet,
  cwd: string,
  extraTools: readonly CoreToolClass[] = [],
  platformPaths: readonly string[] = [],
): { rules: string[]; excluded: string[]; unexpressed: string[] } {
  const rules: string[] = [];
  const unexpressed: string[] = [];
  for (const path of deny.paths) {
    const pattern = qwenPathPattern(cwd, path);
    if (pattern === null) {
      unexpressed.push(path);
      continue;
    }
    for (const tool of ['read_file', 'edit'])
      rules.push(`${tool}(${pattern})`, `${tool}(${pattern}/**)`);
  }
  for (const path of deny.paths) {
    for (const share of qwenSharePatterns(path)) {
      for (const tool of ['read_file', 'edit'])
        rules.push(`${tool}(${share})`, `${tool}(${share}/**)`);
    }
  }
  // Поиск или список по предку дома ядра или токена дойдёт до них (F-13): CLI сверяет корень
  // `path` с правилом без маски — запрет на каждый предок. Предок на другом корне — только хук.
  for (const root of new Set(platformPaths.flatMap(ancestors))) {
    const pattern = qwenPathPattern(cwd, root);
    if (pattern !== null) rules.push(`read_file(${pattern})`);
    for (const share of qwenSharePatterns(root)) rules.push(`read_file(${share})`);
  }
  for (const path of deny.editPaths ?? []) {
    const pattern = qwenPathPattern(cwd, path);
    if (pattern === null) {
      unexpressed.push(path);
      continue;
    }
    rules.push(`edit(${pattern})`, `edit(${pattern}/**)`);
  }
  for (const path of deny.editPaths ?? []) {
    for (const share of qwenSharePatterns(path)) rules.push(`edit(${share})`, `edit(${share}/**)`);
  }
  for (const argv of deny.commands) rules.push(`run_shell_command(${argv.join(' ')}:*)`);
  rules.push(...deny.mcpTools);
  const classes = [...new Set([...deny.tools, ...extraTools])];
  const excluded = classes.flatMap((c) => QWEN_TOOL_NAMES[c]);
  rules.push(...excluded);
  return { rules, excluded: [...excluded, ...deny.mcpTools], unexpressed };
}
