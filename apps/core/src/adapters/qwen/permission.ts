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
 * инструменты (ядра тоже), `todo_write` ведёт список дел сеанса. `agent`/`skill` — свои классы
 * `subagent`/`skill` (судятся по фактам слоя), `tool_call` действует — `other`.
 */
const CONVERSATION_TOOLS = new Set(['tool_search', 'todo_write']);

/** Класс ядра → встроенные инструменты Qwen Code. */
export const QWEN_TOOL_NAMES: Record<CoreToolClass, string[]> = {
  write: ['write_file'],
  edit: ['edit', 'notebook_edit'],
  shell: ['run_shell_command', 'monitor'],
  web: ['web_fetch', 'web_search'],
};

/**
 * Все встроенные инструменты Qwen Code 0.24.3 — значения `ToolNames`
 * (`packages/core/src/tools/tool-names.ts` сборки). Список ведёт тест по настоящей сборке
 * (`qwen.builtins.test.ts`): новое имя в `ToolNames`, которого здесь нет, — красный тест, а не
 * молча предложенный модели инструмент под набором `none`.
 */
export const QWEN_BUILTIN_TOOLS: readonly string[] = [
  ...['exec', 'edit', 'write_file', 'read_file', 'zoom_image', 'grep_search', 'glob'],
  ...['run_shell_command', 'todo_write', 'save_memory', 'agent', 'skill'],
  ...['exit_plan_mode', 'enter_plan_mode', 'web_fetch', 'web_search', 'image_gen'],
  ...['list_directory', 'lsp', 'ask_user_question', 'cron_create', 'cron_list', 'cron_delete'],
  ...['loop_wakeup', 'create_sub_session', 'list_agents', 'task_stop', 'task_create'],
  ...['task_update', 'task_list', 'team_create', 'team_delete', 'team_plan_approval'],
  ...['request_shutdown', 'send_message', 'structured_output', 'monitor', 'notebook_edit'],
  ...['tool_call', 'tool_search', 'read_mcp_resource', 'enter_worktree', 'exit_worktree'],
  ...['workflow', 'artifact', 'record_artifact', 'record_source', 'report_findings'],
  ...['get_goal', 'update_goal', 'propose_goal', 'display_image'],
  ...['omni_downsample_image', 'omni_downscale_video', 'omni_downsample_audio'],
  ...['omni_extract_keyframes', 'omni_extract_audio', 'omni_clip_video', 'omni_convert_image'],
  ...['omni_transcribe_audio', 'omni_clip_image', 'omni_clip_audio', 'omni_caption_image'],
  ...['omni_caption_audio', 'omni_ocr_image', 'omni_understand_video_segments'],
  'omni_recall_media_memory',
];

/**
 * Набор `none` (вопрос «ask», этап 10 F2): КАЖДЫЙ встроенный инструмент — в `--exclude-tools`,
 * остаются только серверы MCP дороги. Прежний набор оставлял «безвредные» и пропускал новые
 * имена сборки (`enter_worktree`, `cron_*`, `send_message`… — F3, кейс panel-agent-foreign-001).
 * `tool_search` тоже снят: серверы MCP сеанса Qwen Code отдаёт модели списком (проба 02.11 —
 * мост панели виден и без него).
 */
export const QWEN_NONE_EXCLUDED: readonly string[] = QWEN_BUILTIN_TOOLS;

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

const lineIndex = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * Диапазон `read_file` (этап 8): `offset` у Qwen Code — индекс строки с нуля (проба 0.24.3: offset
 * 10 → «Read lines 11-15»), в канон ядра (номер первой строки с единицы) — плюс один, чтобы
 * диапазоны обоих CLI сравнивались одинаково. Ни одного поля — «без диапазона» (`null`); Qwen
 * при этом сам режет большой файл по размеру («Read lines 1-252 of 400 (truncated)»).
 */
export function qwenReadRange(input: Record<string, unknown>): PermissionAsk['range'] {
  const offset = lineIndex(input.offset);
  const limit = lineIndex(input.limit);
  if (offset === null && limit === null) return null;
  return { offset: offset === null ? null : offset + 1, limit };
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
    return {
      action: 'read',
      target,
      ...(tool === 'read_file' ? { range: qwenReadRange(input) } : {}),
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
  // Проба L Q7 (0.24.3): навык — `skill {skill, args?}`, подагент — `agent {description, prompt,
  // subagent_type}`; модели в вызове нет — модель определения или сеанса.
  if (tool === 'skill') {
    const target = text(input.skill);
    return { action: 'skill', target, tool, display: `${tool} ${target}`.trim() };
  }
  if (tool === 'agent') {
    const target = text(input.subagent_type);
    return { action: 'subagent', target, model: null, tool, display: `${tool} ${target}`.trim() };
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
