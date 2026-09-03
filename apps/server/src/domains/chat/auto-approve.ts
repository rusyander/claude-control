/**
 * Автоподтверждение прав в чате.
 *
 * Тумблер в шапке чата снимает с человека рутину: запрос агента на инструмент
 * разрешается сам, и карточка «Разрешить/Запретить» не появляется.
 *
 * ГРАНИЦА — БЕЗВОЗВРАТНОСТЬ, а не «запись» (решение владельца, 03.09.2026;
 * заменяет прежнюю осторожную границу). Прежний список считал опасной любую
 * запись: коммит, пуш, перенос файла, `kill`, `ssh`, POST-запрос, любой
 * MCP-инструмент с глаголом записи, — и агент вставал по десятку раз за прогон
 * на том, что человек всё равно разрешал. «Ложное спросить стоит одного клика»
 * оказалось неправдой: пока клика нет, работа СТОИТ, а человек в этот момент
 * смотрит в другую вкладку — ради чего разделение и заводили. Поэтому спрашиваем
 * ровно там, где отменить сделанное нечем: удаление, затирание истории, снос
 * данных и инфраструктуры, публикация в чужой реестр. Коммит, ветка, пуш,
 * перенос, перезапуск процесса, запрос к API — уходят агенту.
 *
 * Два предохранителя сверх этого не тронуты: правила `ask`/`deny` из
 * settings.json (человек сам сказал «спрашивай» — здесь это перевешивает всё) и
 * выключенный тумблер правок, который значит «только чтение».
 *
 * Непонятный случай (нет команды, незнакомая форма ввода) по-прежнему уходит
 * человеку: гадать, что именно исполнится, нельзя.
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
 * Инструмент MCP, который на той стороне что-то СНОСИТ. Имена у серверов разные,
 * поэтому смотрим на глагол в названии. Создать задачу, написать комментарий,
 * повесить метку — обычная работа: это правится там же, где сделано. Удаление
 * страницы и слияние запроса правится уже не отсюда.
 */
const MCP_DESTRUCTIVE = /(delete|remove|destroy|purge|drop|merge|unpublish|revoke)/i;

/**
 * Безвозвратные команды оболочки. Проверяются по каждому звену конвейера,
 * поэтому `ls && rm -rf dist` не проскочит из-за безобидного начала.
 */
const IRREVERSIBLE_SEGMENT: RegExp[] = [
  // Удаление и затирание на диске. Слева требуем начало звена или пробел, а не
  // просто границу слова: иначе `docker run --rm` — стандартный одноразовый
  // запуск — читается как `rm` и останавливает прогон на ровном месте.
  /(^|[\s(])(rm|rmdir|unlink|shred|truncate|dd|mkfs|diskpart)\b/i,
  /(^|[\s(])(del|rd|erase|Remove-Item|Clear-Content)\b/i,
  /\breg\s+delete\b/i,
  // Git — только то, что стирает работу или историю. Коммит, ветка, пуш, перенос
  // и перебазирование здесь не значатся: они восстанавливаются из reflog и с
  // удалённого, а стоят агенту остановки на каждом шаге.
  /\bgit\s+(clean|filter-branch)\b/i,
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bgit\s+(branch|tag)\b[^\n]*\s(-D|-d|--delete)\b/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bgit\s+worktree\s+(remove|prune)\b/i,
  /\bgit\s+reflog\s+(expire|delete)\b/i,
  // База данных: схема и данные.
  /\b(drop|truncate)\b/i,
  /\bdelete\s+from\b/i,
  /\b(migrate|migration)\b.*\b(down|reset|fresh)\b/i,
  /\bprisma\s+migrate\s+reset\b/i,
  // Контейнеры, кластер, инфраструктура — снос, а не запуск. Подкоманда идёт
  // сразу за именем: `docker run --rm` тем же `rm` не является.
  /\b(docker|podman)\s+(rm|rmi|prune)\b/i,
  /\b(docker|podman)\s+(system|image|volume|container|network)\s+(prune|rm)\b/i,
  /\bdocker-compose\s+down\b[^\n]*\s-v\b/i,
  /\bkubectl\s+delete\b/i,
  /\bhelm\s+(delete|uninstall)\b/i,
  /\b(terraform|tofu|pulumi)\s+destroy\b/i,
  // Публикация в чужой реестр: снять её уже не отсюда.
  /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate)\b/i,
  // Хостинги репозиториев: удаление и слияние. Остальное — обычная работа.
  /\b(gh|glab)\s+[a-z-]+\s+(delete|merge)\b/i,
  // Удаление по сети и остановка машины.
  /\bcurl\b[^\n]*\s-X\s*['"]?DELETE/i,
  /\b(shutdown|reboot|halt)\b/i,
];

/** Проверяется по команде целиком: конвейер сам по себе и есть признак. */
const IRREVERSIBLE_WHOLE: RegExp[] = [
  // Скачал и сразу исполнил. Не удаление, но и не то, что подтверждают молча:
  // что именно исполнится, до запуска не знает никто.
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i,
  // Принудительный пуш: чужая работа исчезает из ветки.
  /\bgit\s+push\b[^\n]*(--force|--force-with-lease|-f)\b/i,
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

function isIrreversibleCommand(command: string): boolean {
  if (IRREVERSIBLE_WHOLE.some((rule) => rule.test(command))) return true;
  return segments(command).some((segment) =>
    IRREVERSIBLE_SEGMENT.some((rule) => rule.test(segment)),
  );
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

  // Сносящее через MCP (удалить страницу, слить запрос) — через человека.
  if (toolName.startsWith('mcp__') && MCP_DESTRUCTIVE.test(toolName)) return false;

  if (toolName === 'Bash') {
    const command = bashCommand(input);
    if (command === undefined) return false;
    if (isIrreversibleCommand(command)) return false;
  }

  return !guardedPatterns.some((pattern) => matchesRule(pattern, toolName, input));
}
