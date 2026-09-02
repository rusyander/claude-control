/**
 * Автоподтверждение прав в чате.
 *
 * Тумблер в шапке чата снимает с человека рутину: запрос агента на инструмент
 * разрешается сам, и карточка «Разрешить/Запретить» не появляется. Но не любой:
 * решение остаётся за человеком там, где ошибка необратима — записи в git
 * (push/commit/merge), удаление, миграции и прочее «и всякое такое», — а также
 * везде, где сам пользователь просил спрашивать, то есть в правилах `ask`/`deny`
 * из settings.json.
 *
 * Логика намеренно осторожная: непонятный случай (нет команды, незнакомая форма
 * ввода, инструмент под правилом) считается опасным и уходит человеку. Ложное
 * «спросить» стоит одного клика, ложное «разрешить» — потерянной работы.
 *
 * Права `deny` сюда обычно не доходят (их Claude Code режет сам, не спрашивая),
 * но в список охраняемых они всё равно входят: страховка ничего не стоит.
 */

export interface AutoApproveInput {
  toolName: string;
  input: unknown;
  /** Паттерны правил `ask` и `deny` из settings.json — по ним спрашиваем всегда. */
  guardedPatterns: string[];
  /**
   * Разрешены ли правки файлов в этом прогоне. Выключенный тумблер правок
   * значит «только чтение», и автоподтверждение не вправе его отменять.
   */
  allowEdits: boolean;
}

/** Инструменты, меняющие файлы: под «только чтение» их подтверждает человек. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Инструмент MCP, меняющий что-то на той стороне (issue, MR, страница вики).
 * Имена у серверов разные, поэтому смотрим на глагол в названии.
 */
const MCP_WRITE =
  /(create|update|edit|delete|remove|write|push|merge|commit|comment|post|send|upload|attach|add|set|move|transition|assign|close|approve|rename|archive|publish)/i;

/**
 * Опасные команды оболочки. Проверяются по каждому звену конвейера, поэтому
 * `ls && git push` не проскочит из-за безобидного начала.
 */
const DANGEROUS_SEGMENT: RegExp[] = [
  // Записи в git: коммит, пуш, слияние, перенос и переписывание истории.
  /\bgit\s+(push|commit|merge|rebase|reset|revert|checkout|switch|branch|tag|cherry-pick|stash|clean|am|apply|remote|submodule|filter-branch|gc|prune|restore|worktree)\b/i,
  // Удаление и перезапись на диске.
  /\b(rm|rmdir|unlink|shred|truncate|mv|dd|mkfs|diskpart)\b/i,
  /(^|[\s(])(del|rd|erase|move|Remove-Item|Clear-Content)\b/i,
  // Права, владение, процессы, питание машины.
  /\b(sudo|doas|runas|chmod|chown|chattr|icacls|attrib|takeown)\b/i,
  /\b(kill|killall|pkill|taskkill|shutdown|reboot|halt)\b/i,
  /\breg\s+(add|delete|import)\b/i,
  // Публикация пакетов и вход по токену.
  /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|login|adduser|token)\b/i,
  // Хостинги репозиториев: всё, что не чтение, — через человека.
  /\b(gh|glab)\s+(pr|mr|issue|release|repo|api|workflow|run|label|variable|secret|auth)\b/i,
  // Контейнеры, кластер, инфраструктура.
  /\b(docker|podman)\s+(rm|rmi|prune|kill|stop|system|push)\b/i,
  /\bdocker-compose\s+(down|rm)\b/i,
  /\bkubectl\s+(delete|apply|scale|rollout|drain|cordon|patch|edit|exec|create)\b/i,
  /\b(terraform|tofu|pulumi)\s+(apply|destroy|import)\b/i,
  // База данных: схема и данные.
  /\b(drop|truncate|alter\s+table|grant|revoke)\b/i,
  /\bdelete\s+from\b/i,
  /\b(migrate|migration)\b.*\b(up|down|deploy|reset|fresh)\b/i,
  /\bprisma\s+(migrate|db)\b/i,
  // Сеть с записью и удалённые хосты.
  /\bcurl\b[^\n]*\s-X\s*['"]?(POST|PUT|PATCH|DELETE)/i,
  /\b(ssh|scp|sftp|rsync)\b/i,
];

/** Проверяется по команде целиком: конвейер сам по себе и есть признак. */
const DANGEROUS_WHOLE: RegExp[] = [
  // Скачал и сразу исполнил.
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i,
  // Принудительный пуш в любой записи (`git push --force`, `-f`).
  /\bgit\s+push\b[^\n]*(--force|-f)\b/i,
];

/** Команда оболочки из ввода инструмента Bash; undefined — форма незнакомая. */
function bashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

/** Звенья составной команды: `a && b | c; d`. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isDangerousCommand(command: string): boolean {
  if (DANGEROUS_WHOLE.some((rule) => rule.test(command))) return true;
  return segments(command).some((segment) => DANGEROUS_SEGMENT.some((rule) => rule.test(segment)));
}

/** Паттерн `Tool(spec)` → части; без скобок spec отсутствует. */
function parsePattern(pattern: string): { tool: string; spec?: string } {
  const match = /^([^(]+)\((.*)\)$/.exec(pattern.trim());
  if (!match) return { tool: pattern.trim() };
  return { tool: (match[1] ?? '').trim(), spec: (match[2] ?? '').trim() };
}

/** Спецификация правила `Bash(...)` против конкретной команды. */
function specMatchesCommand(spec: string, command: string): boolean {
  const targets = [command.trim(), ...segments(command)];

  // `git push:*` — префикс команды, так это записано в правах Claude Code.
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim();
    return targets.some((target) => target.startsWith(prefix));
  }

  if (spec.includes('*')) {
    const source = `^${spec.split('*').map(escapeRegExp).join('.*')}$`;
    const rule = new RegExp(source);
    return targets.some((target) => rule.test(target));
  }

  return targets.some((target) => target === spec);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Подпадает ли запрос под правило. Для Bash сверяем саму команду; для остальных
 * инструментов достаточно совпадения имени: раз пользователь завёл правило на
 * этот инструмент, спросить — верное поведение, даже если аргумент не разобрали.
 * MCP-правило может быть на весь сервер (`mcp__jira`) или на инструмент.
 */
function matchesRule(pattern: string, toolName: string, input: unknown): boolean {
  const { tool, spec } = parsePattern(pattern);
  if (!tool) return false;

  const sameTool =
    tool === toolName || (tool.startsWith('mcp__') && toolName.startsWith(`${tool}__`));
  if (!sameTool) return false;

  if (!spec) return true;
  if (toolName !== 'Bash') return true;

  const command = bashCommand(input);
  // Команду не разобрали — считаем, что правило сработало.
  return command === undefined ? true : specMatchesCommand(spec, command);
}

/**
 * Можно ли разрешить запрос без человека. `false` — показываем карточку, как и
 * раньше.
 */
export function shouldAutoApprove(request: AutoApproveInput): boolean {
  const { toolName, input, guardedPatterns, allowEdits } = request;

  // Вопрос человеку не подтверждается автоматически НИКОГДА. «Разрешить» здесь
  // значит «пусть CLI спросит сам», а в режиме `-p` спрашивать ему не у кого:
  // вызов вернётся ошибкой, и развилку агент решит за человека — молча. Тумблер
  // автоподтверждения про инструменты, а не про право выбирать вместо него.
  if (toolName === 'AskUserQuestion') return false;

  // Правки файлов при выключенном тумблере правок — только руками.
  if (!allowEdits && EDIT_TOOLS.has(toolName)) return false;

  // Записи через MCP (issue, MR, страница) — всегда через человека.
  if (toolName.startsWith('mcp__') && MCP_WRITE.test(toolName)) return false;

  if (toolName === 'Bash') {
    const command = bashCommand(input);
    if (command === undefined) return false;
    if (isDangerousCommand(command)) return false;
  }

  return !guardedPatterns.some((pattern) => matchesRule(pattern, toolName, input));
}
