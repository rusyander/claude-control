import { baseSystemSettings } from '../../groups/qwen-layer.ts';
import { decidePermission, type PermissionDecision, type RunScope } from '../run-permissions.ts';

/**
 * Проверка прав прогона тестов у чужого CLI (Qwen Code, Codex).
 *
 * Правила — те же, что у Claude (`run-permissions.ts`: `decidePermission`,
 * `isWritable`, `describeScope` не меняются), разница одна, и она принципиальная:
 * у Claude незнакомый инструмент пропускается, здесь — ОТКАЗ. Claude приходит к
 * брокеру прав за каждым вызовом сам; чужой CLI идёт в режиме без вопросов
 * (Qwen `yolo`) или спрашивает только о том, что считает опасным (Codex), и
 * инструмент, которого панель не знает, может оказаться пишущим. Лучше прогон с
 * отказом в странном инструменте, чем агент, правящий код мимо проверки.
 *
 * Имена и формы вызовов сняты с настоящих CLI на заглушке модели
 * (`.agent/provider-formats.agent.md`, «Tests agent gate probes»).
 */

/**
 * Встроенные инструменты Qwen Code → имена Claude, по которым решает
 * `decidePermission`. Сверено с картой набора панели (`kit-paths.mjs`,
 * `QWEN_TOOLS`) тестом: два перевода одних имён не должны расходиться.
 * `agent`/`task` здесь нет намеренно — субагент снимается с запуска.
 */
export const QWEN_TOOL_NAMES: Readonly<Record<string, string>> = {
  write_file: 'Write',
  edit: 'Edit',
  replace: 'Edit',
  run_shell_command: 'Bash',
  shell: 'Bash',
  read_file: 'Read',
  read_many_files: 'Read',
  glob: 'Glob',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  list_directory: 'LS',
  web_fetch: 'WebFetch',
  todo_write: 'TodoWrite',
};

/**
 * Прочие инструменты Qwen Code 0.25 (кадр `system/init`, проба P1): снимаются с
 * запуска `--exclude-tools`. Пишущие (`notebook_edit`), субагенты (`agent`),
 * память в `~/.qwen` (`manage_memory`), обход по имени (`tool_call`) и прочее,
 * что прогону тестов не нужно. Новый инструмент новой версии сюда сам не
 * попадёт — его ловит сверка кадра `init` (`unexpectedQwenTools`).
 */
export const QWEN_TESTS_EXCLUDED_TOOLS: readonly string[] = [
  'read_mcp_resource',
  'zoom_image',
  'cron_create',
  'cron_list',
  'cron_delete',
  'list_agents',
  'agent',
  'task',
  'task_stop',
  'send_message',
  'skill',
  'search_memory',
  'manage_memory',
  'save_memory',
  'record_artifact',
  'loop_wakeup',
  'get_goal',
  'update_goal',
  'tool_call',
  'tool_search',
  'notebook_edit',
  'report_findings',
  'enter_worktree',
  'exit_worktree',
  'monitor',
];

/**
 * Встроенные инструменты кадра `init`, которых панель не знает: с ними прогон не
 * идёт. Инструменты MCP (`mcp__сервер__имя`) сюда не попадают: их набор задаёт
 * человек своими серверами, а не версия Qwen, и каждый их вызов хук и так
 * отклоняет как незнакомый (`decideQwenCall`) — обрывать из-за них прогон
 * значило бы запретить Qwen любому, у кого подключён хоть один сервер.
 */
export function unexpectedQwenTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (name): name is string =>
      typeof name === 'string' &&
      !name.startsWith('mcp__') &&
      !Object.hasOwn(QWEN_TOOL_NAMES, name),
  );
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Отказ с причиной для модели — она увидит его результатом вызова. */
function deny(message: string): PermissionDecision {
  return { behavior: 'deny', message };
}

const UNKNOWN_TOOL = (name: string): string =>
  `The tool ${name || '(unnamed)'} is not available in this test run: the panel cannot check what it touches. Use read_file, write_file, edit, run_shell_command, glob or grep_search.`;

/**
 * Вызов Qwen в форме Claude: имя и вход, по которым решает `decidePermission`.
 * `undefined` — инструмент панели незнаком.
 */
export function normalizeQwenCall(
  toolName: string,
  input: unknown,
): { tool: string; input: Record<string, unknown> } | undefined {
  const tool = Object.hasOwn(QWEN_TOOL_NAMES, toolName) ? QWEN_TOOL_NAMES[toolName] : undefined;
  if (!tool) return undefined;
  const raw = record(input);
  const file = text(raw.file_path) ?? text(raw.absolute_path) ?? text(raw.absolutePath);
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') {
    return { tool, input: { ...raw, ...(file ? { file_path: file } : {}) } };
  }
  return { tool, input: raw };
}

/** Решение по вызову Qwen Code — то, что хук проверки получает от панели. */
export function decideQwenCall(
  scope: RunScope,
  toolName: string,
  input: unknown,
): PermissionDecision {
  const call = normalizeQwenCall(toolName, input);
  if (!call) return deny(UNKNOWN_TOOL(toolName));
  // Запись без пути `decidePermission` пропускает (так было у Claude); здесь путь
  // обязателен: пишущий вызов, цель которого не прочитать, — отказ, а не догадка.
  if ((call.tool === 'Write' || call.tool === 'Edit') && !text(call.input.file_path)) {
    return deny(
      `The ${toolName} call names no file_path — the panel cannot check where it writes.`,
    );
  }
  if (call.tool === 'Bash' && !text(call.input.command)) {
    return deny('The shell call names no command.');
  }
  return decidePermission(scope, call.tool, call.input);
}

/** Одна правка файла `fileChange` Codex (app-server, `item/started`). */
interface CodexChange {
  path: string;
  type: 'add' | 'update' | 'delete';
  movePath?: string;
}

/** Правки из элемента `fileChange` (`changes[{path, kind{type, move_path}}]`); ошибка формы — `undefined`. */
export function codexChangesOf(changes: unknown): CodexChange[] | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const out: CodexChange[] = [];
  for (const raw of changes) {
    const change = record(raw);
    const kind = record(change.kind);
    const path = text(change.path);
    const type = kind.type;
    if (!path || (type !== 'add' && type !== 'update' && type !== 'delete')) return undefined;
    const movePath = text(kind.move_path);
    out.push({ path, type, ...(movePath ? { movePath } : {}) });
  }
  return out;
}

/** Правки устаревшего `applyPatchApproval` (`fileChanges{path: {type, move_path}}`). */
export function codexLegacyChangesOf(fileChanges: unknown): CodexChange[] | undefined {
  const map = record(fileChanges);
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  return codexChangesOf(
    entries.map(([path, change]) => ({
      path,
      kind: { type: record(change).type, move_path: record(change).move_path },
    })),
  );
}

/**
 * Решение по правкам Codex: каждая правка — Write (новый файл, удаление) или
 * Edit (изменение; при переносе — оба пути). Одна правка вне границ — отказ всей
 * пачке: принять половину патча Codex не умеет.
 */
export function decideCodexChanges(
  scope: RunScope,
  changes: readonly CodexChange[] | undefined,
): PermissionDecision {
  if (!changes || changes.length === 0) {
    return deny('The panel could not read which files this change touches.');
  }
  for (const change of changes) {
    const targets = [change.path, ...(change.movePath ? [change.movePath] : [])];
    const tool = change.type === 'update' ? 'Edit' : 'Write';
    for (const file_path of targets) {
      const decision = decidePermission(scope, tool, { file_path });
      if (decision.behavior === 'deny') return decision;
    }
  }
  return { behavior: 'allow' };
}

/**
 * Решение по команде Codex. Строка `command` — обёртка оболочки
 * (`pwsh.exe -Command '…'`), `commandActions[].command` — сама команда; запрет на
 * правку истории проверяется по обеим: обёртка может смениться, команда — нет.
 */
export function decideCodexCommand(scope: RunScope, params: unknown): PermissionDecision {
  const raw = record(params);
  const command = Array.isArray(raw.command)
    ? raw.command.filter((part) => typeof part === 'string').join(' ')
    : text(raw.command);
  const actions = Array.isArray(raw.commandActions)
    ? raw.commandActions.map((action) => text(record(action).command)).filter(Boolean)
    : [];
  const lines = [command, ...actions].filter((line): line is string => Boolean(line));
  if (lines.length === 0) return deny('The panel could not read the command to check it.');
  for (const line of lines) {
    const decision = decidePermission(scope, 'Bash', { command: line });
    if (decision.behavior === 'deny') return decision;
  }
  return { behavior: 'allow' };
}

/**
 * Ответ Codex по решению. `acceptForSession` не отправляется НИКОГДА: он
 * разрешил бы следующие правки тех же файлов без вопроса, то есть без проверки.
 */
export function codexVerdict(decision: PermissionDecision): 'accept' | 'decline' {
  return decision.behavior === 'allow' ? 'accept' : 'decline';
}

/** Сколько ждёт CLI хук проверки — больше, чем сам хук ждёт панель (8 с). */
export const QWEN_GATE_HOOK_TIMEOUT_MS = 15_000;

/**
 * Системные настройки Qwen на прогон: всё, что уже лежало в системном слое
 * (файл из окружения или общий файл машины), плюс хук проверки прав на КАЖДЫЙ
 * вызов. Один сборщик на файл — второй писатель того же
 * `QWEN_CODE_SYSTEM_SETTINGS_PATH` стёр бы либо хук, либо чужой слой.
 *
 * - хук без `matcher` — срабатывает на любой инструмент (проба P1);
 * - `disableAllHooks:false` системного слоя перебивает `true` человека и проекта
 *   (проба P2) — иначе одна строка в настройках проекта снимала бы проверку.
 */
export function composeQwenGateSettings(
  env: NodeJS.ProcessEnv,
  hookCommand: string,
): Record<string, unknown> {
  const base = baseSystemSettings(env);
  const hooks = record(base.hooks);
  const prior = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  return {
    ...base,
    disableAllHooks: false,
    hooks: {
      ...hooks,
      PreToolUse: [
        { hooks: [{ type: 'command', command: hookCommand, timeout: QWEN_GATE_HOOK_TIMEOUT_MS }] },
        ...prior,
      ],
    },
  };
}
