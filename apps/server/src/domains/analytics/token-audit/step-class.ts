import { QWEN_TOOL_NAMES } from '../../project-tests/agent/foreign-gate.ts';

/**
 * Класс шага по его инструментам: где уходит окно — в снимках, гейтах, чтении.
 * Порядок важен: первый подошедший класс побеждает, поэтому узкие (снимки,
 * гейты) стоят раньше широких (чтение, правка). Правила общие для любого
 * проекта: имена скриптов конкретного репозитория сюда не попадают.
 */
const STEP_CLASSES: Array<[string, RegExp]> = [
  ['shots', /e2e\/|shots?\b|screenshot|playwright|chromium|\.png\b/i],
  [
    'gate',
    /\b(type-?check|lint|vitest|jest|pytest|go test|tsc|tests-cli|gate\d*|check_\w+|(pnpm|npm|yarn) (run )?test)\b/i,
  ],
  ['tracker', /jira|confluence|merge_request|gitlab|\bglab\b|\bgh (pr|issue)\b|ledger/i],
  ['git', /(^|\s)git(\s+-C\s+\S+)?\s+\w/],
  ['dev-server', /\bvite\b|dev server|localhost:\d+|127\.0\.0\.1:\d+|\bcurl\b/i],
  ['subagent', /^(Agent|Task)\b/],
  ['skill', /^Skill\b/],
  ['read', /^(Read|Grep|Glob|LS)\b|(^|[;&|]\s*)(cat|sed -n|head|tail|grep|rg|ls|find|wc)\b/],
  ['edit', /^(Edit|Write|MultiEdit|NotebookEdit)\b|sed -i|writeFileSync|cat\s*>/],
];

export interface ToolUseLike {
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Встроенные инструменты Codex и субагенты Qwen Code → имена Claude; остальное
 * у Qwen — карта шлюза тестов (`QWEN_TOOL_NAMES`), второй перевод не заводится.
 */
const FOREIGN_TOOL_NAMES: Readonly<Record<string, string>> = {
  shell: 'Bash',
  shell_command: 'Bash',
  exec_command: 'Bash',
  local_shell: 'Bash',
  apply_patch: 'Edit',
  read_file: 'Read',
  list_dir: 'LS',
  grep_files: 'Grep',
  agent: 'Agent',
  task: 'Task',
};

/** Команда оболочки: строкой или argv, где `["bash", "-lc", "…"]` несёт её последней. */
function shellCommand(input: Record<string, unknown>): string | undefined {
  const raw = input.command ?? input.cmd;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw) || !raw.every((part) => typeof part === 'string')) return undefined;
  const flag = raw.at(-2);
  return typeof flag === 'string' && /^-(l?c|Command)$/i.test(flag) ? raw.at(-1) : raw.join(' ');
}

/**
 * Вызов Codex или Qwen Code в словах Claude: его оболочка, чтение и правка
 * зовутся иначе (`shell`, `run_shell_command`, `apply_patch`, `read_file`), и
 * без перевода каждый шаг этих групп уходил в «прочее» (ревью A2-F12).
 */
export function foreignToolUse(name: string, input: Record<string, unknown> = {}): ToolUseLike {
  const key = name.toLowerCase();
  const claude = FOREIGN_TOOL_NAMES[key] ?? QWEN_TOOL_NAMES[key];
  if (claude !== 'Bash') return { name: claude ?? name, input };
  const command = shellCommand(input);
  return { name: claude, input: command ? { command } : {} };
}

/** Подпись вызова для классификации: имя инструмента и его главный аргумент. */
function signature(use: ToolUseLike): string {
  const input = use.input ?? {};
  const command = typeof input.command === 'string' ? input.command : undefined;
  const arg =
    command ??
    (typeof input.file_path === 'string' ? input.file_path : undefined) ??
    (typeof input.pattern === 'string' ? input.pattern : undefined) ??
    JSON.stringify(input).slice(0, 200);
  return `${use.name ?? '?'} ${arg}`;
}

/** Класс шага: `text` — ответ без инструментов, `other` — инструмент вне классов. */
export function stepClass(uses: ToolUseLike[]): string {
  if (uses.length === 0) return 'text';
  // Команды Bash начинаются с `cd …` — их классифицирует то, что идёт после.
  const sig = uses
    .map((use) => signature(use).replace(/^(Bash )(\s*(cd|export) [^;&]+(&&|;)\s*)+/, '$1'))
    .join(' ; ');
  for (const [name, pattern] of STEP_CLASSES) {
    if (pattern.test(sig)) return name;
    // Bash-команды проверяются и без префикса инструмента: `^cat` должен ловить `Bash cat`.
    if (sig.startsWith('Bash ') && pattern.test(sig.slice(5))) return name;
  }
  return uses.some((use) => use.name?.startsWith('mcp__')) ? 'mcp' : 'other';
}
