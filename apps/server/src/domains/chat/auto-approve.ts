// Подмодулем, а не индексом контрактов: сервер исполняет TypeScript как есть
// (`--experimental-strip-types`), а в индексе реэкспорты без расширений — их
// Node не разрешает, и первый же ЗНАЧЕНИЕВОЙ импорт оттуда роняет процесс.
import {
  allowedPermissionRules,
  type PermissionRuleId,
} from '@agentdeck/contracts/permission-rules';

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
 * САМА ЭТА ГРАНИЦА ТЕПЕРЬ НАСТРАИВАЕТСЯ (решение владельца, 07.09.2026).
 * Запрос, попавший в охраняемую область, сперва называется ПРАВИЛОМ
 * (`PermissionRuleId`), и спрашиваем мы только тогда, когда это правило
 * выключено. Правила глобальные и живут в настройках панели — их состав,
 * значения по умолчанию и причина такого деления лежат в
 * `contracts/permission-rules.ts`. Здесь — разбор: какая команда и какой
 * инструмент к какому правилу относятся.
 *
 * Два предохранителя сверх этого не тронуты: правила `ask`/`deny` из
 * settings.json (человек сам сказал «спрашивай» — здесь это перевешивает всё) и
 * выключенный тумблер правок, который значит «только чтение».
 *
 * Непонятный случай (нет команды, незнакомая форма ввода) по-прежнему уходит
 * человеку: гадать, что именно исполнится, нельзя.
 *
 * ЧТЕНИЕ — ВСЕГДА (решение владельца, 07.09.2026). Открыть файл, найти по
 * шаблону, посмотреть каталог — действие, которое нечего отменять, а карточка
 * на каждый такой вызов стоила прогону остановки по десятку раз: агент читает
 * куда чаще, чем пишет. Поэтому читающие инструменты подтверждаются сами, и
 * тумблер автоподтверждения на них не влияет — выключенный он означает «спроси
 * перед ДЕЙСТВИЕМ», а не «спроси перед взглядом». Правила `ask` на чтение здесь
 * тоже перестают спрашивать; `deny` это не касается — их Claude Code режет у
 * себя, до панели такой вызов не доходит вовсе.
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
  /**
   * Правила, которые человек разрешил подтверждать без него. Не задано —
   * значения по умолчанию из контрактов (см. `allowedPermissionRules`).
   */
  allowedRules?: ReadonlySet<string>;
}

/**
 * Правила по умолчанию — на случай вызова без настроек (тесты, прогон мимо
 * маршрута). Считается один раз: набор не меняется в течение жизни процесса.
 */
const DEFAULT_ALLOWED: ReadonlySet<string> = allowedPermissionRules(undefined);

/** Инструменты, меняющие файлы: под «только чтение» их подтверждает человек. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Инструменты, которые только СМОТРЯТ: файл, дерево каталогов, поиск по коду.
 * Ничего не меняют ни на диске, ни снаружи, поэтому спрашивать за них нечего.
 * Сетевые (`WebFetch`, `WebSearch`) сюда не входят: там читается чужая сторона,
 * и правило пользователя на такой вызов должно оставаться в силе.
 */
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoRead',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

/** Читающий ли это инструмент — вызывающая сторона решает по нему, спрашивать ли вообще. */
export function isReadOnlyTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}

/**
 * Инструмент MCP, который на той стороне что-то СНОСИТ. Имена у серверов разные,
 * поэтому смотрим на ГЛАГОЛ — и именно на глагол в начале имени, а не на любое
 * вхождение слова: `create_merge_request_thread` — это комментарий в запросе на
 * слияние, а не слияние, и пока проверка искала «merge» где угодно, КАЖДЫЙ
 * инструмент вокруг merge request'ов останавливал прогон карточкой. Ровно на
 * этом человек и уставал жать «Разрешить».
 */
const MCP_DESTRUCTIVE = /^(delete|remove|destroy|purge|drop|merge|unpublish|revoke)(_|$)/i;

/**
 * Инструмент MCP, который только СМОТРИТ. Чтение на той стороне отменять нечего
 * — так же, как и чтение файла, — поэтому под правило записи оно не идёт вовсе:
 * иначе выключенное «записи во внешние сервисы» останавливало бы прогон на
 * каждом `get_merge_request`, то есть на самой частой операции.
 */
const MCP_READ =
  /^(get|list|search|read|fetch|find|show|view|describe|query|count|check|validate|verify|discover|download|health|whoami|my)(_|$)/i;

/** Имя инструмента без префикса `mcp__<сервер>__` — глагол ищется в нём. */
function mcpVerbPart(toolName: string): string {
  return toolName.split('__').at(-1) ?? '';
}

/**
 * Что именно охраняется в этой команде или инструменте. `undefined` — обычная
 * обратимая работа, о ней человека не спрашивают вовсе.
 *
 * Правила проверяются по порядку, и порядок значим: `git push --force` — это
 * затирание истории, а не обычный пуш, поэтому `gitHistory` идёт раньше
 * `gitWrite`.
 */
interface RuleMatcher {
  id: PermissionRuleId;
  /** Проверяется по каждому звену конвейера: `ls && rm -rf dist` не проскочит. */
  segment?: RegExp[];
  /** Проверяется по команде целиком: конвейер сам по себе и есть признак. */
  whole?: RegExp[];
}

const COMMAND_RULES: RuleMatcher[] = [
  {
    // Удаление и затирание на диске. Слева требуем начало звена или пробел, а не
    // просто границу слова: иначе `docker run --rm` — стандартный одноразовый
    // запуск — читается как `rm` и останавливает прогон на ровном месте.
    id: 'filesDelete',
    segment: [
      /(^|[\s(])(rm|rmdir|unlink|shred|truncate|dd|mkfs|diskpart)\b/i,
      /(^|[\s(])(del|rd|erase|Remove-Item|Clear-Content)\b/i,
      /\breg\s+delete\b/i,
    ],
  },
  {
    // Git — только то, что стирает работу или историю. Коммит, ветка, пуш,
    // перенос и перебазирование сюда не входят: они восстанавливаются из reflog
    // и с удалённого (см. `gitWrite` ниже).
    id: 'gitHistory',
    segment: [
      /\bgit\s+(clean|filter-branch)\b/i,
      /\bgit\s+reset\b[^\n]*--hard\b/i,
      /\bgit\s+restore\b/i,
      /\bgit\s+checkout\s+--\s/i,
      /\bgit\s+(branch|tag)\b[^\n]*\s(-D|-d|--delete)\b/i,
      /\bgit\s+stash\s+(drop|clear)\b/i,
      /\bgit\s+worktree\s+(remove|prune)\b/i,
      /\bgit\s+reflog\s+(expire|delete)\b/i,
    ],
    // Принудительный пуш: чужая работа исчезает из ветки.
    whole: [/\bgit\s+push\b[^\n]*(--force|--force-with-lease|-f)\b/i],
  },
  {
    // База данных: схема и данные.
    id: 'database',
    segment: [
      /\b(drop|truncate)\b/i,
      /\bdelete\s+from\b/i,
      /\b(migrate|migration)\b.*\b(down|reset|fresh)\b/i,
      /\bprisma\s+migrate\s+reset\b/i,
    ],
  },
  {
    // Контейнеры, кластер, инфраструктура, питание машины — снос, а не запуск.
    // Подкоманда идёт сразу за именем: `docker run --rm` тем же `rm` не является.
    id: 'infrastructure',
    segment: [
      /\b(docker|podman)\s+(rm|rmi|prune)\b/i,
      /\b(docker|podman)\s+(system|image|volume|container|network)\s+(prune|rm)\b/i,
      /\bdocker-compose\s+down\b[^\n]*\s-v\b/i,
      /\bkubectl\s+delete\b/i,
      /\bhelm\s+(delete|uninstall)\b/i,
      /\b(terraform|tofu|pulumi)\s+destroy\b/i,
      /\b(shutdown|reboot|halt)\b/i,
    ],
  },
  {
    // Публикация в чужой реестр: снять её уже не отсюда.
    id: 'packagePublish',
    segment: [/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate)\b/i],
  },
  {
    // Хостинги репозиториев и трекеры через их CLI: удаление и слияние.
    // Остальное (комментарий, MR, тикет) — обычная работа, см. `externalWrite`.
    id: 'externalDestroy',
    segment: [/\b(gh|glab)\s+[a-z-]+\s+(delete|merge)\b/i],
  },
  {
    // Скачал и сразу исполнил, удалил по сети. Не файлы на диске, но и не то,
    // что подтверждают молча: что именно исполнится, до запуска не знает никто.
    id: 'networkExec',
    segment: [/\bcurl\b[^\n]*\s-X\s*['"]?DELETE/i],
    whole: [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i],
  },
  {
    // Обычная работа с репозиторием. Правило существует не ради запрета, а ради
    // ВЫБОРА: кому нужен просмотр каждого коммита и пуша — выключает тумблер, и
    // они снова спрашивают.
    id: 'gitWrite',
    segment: [/\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|tag|branch|switch)\b/i],
  },
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

/**
 * Правило, под которое подпадает запрос; `undefined` — обычная обратимая
 * работа. Экспортируется ради тестов и справки: по нему видно, ЧТО именно
 * снимет тумблер.
 */
export function ruleFor(toolName: string, input: unknown): PermissionRuleId | undefined {
  if (toolName.startsWith('mcp__')) {
    const verb = mcpVerbPart(toolName);
    if (MCP_DESTRUCTIVE.test(verb)) return 'externalDestroy';
    return MCP_READ.test(verb) ? undefined : 'externalWrite';
  }

  if (toolName !== 'Bash') return undefined;
  const command = bashCommand(input);
  if (command === undefined) return undefined;

  const parts = segments(command);
  for (const rule of COMMAND_RULES) {
    if (rule.whole?.some((pattern) => pattern.test(command))) return rule.id;
    if (rule.segment?.some((pattern) => parts.some((part) => pattern.test(part)))) return rule.id;
  }

  return undefined;
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
  const { toolName, input, guardedPatterns, allowEdits, allowedRules } = request;

  // Вопрос человеку не подтверждается автоматически НИКОГДА. «Разрешить» здесь
  // значит «пусть CLI спросит сам», а в режиме `-p` спрашивать ему не у кого:
  // вызов вернётся ошибкой, и развилку агент решит за человека — молча. Тумблер
  // автоподтверждения про инструменты, а не про право выбирать вместо него.
  if (toolName === 'AskUserQuestion') return false;

  // Чтение разрешается всегда и раньше всех проверок: отменять тут нечего, а
  // остановка прогона ради «Разрешить» на каждом открытом файле обесценивает
  // саму работу агента. Правила `ask` пользователя сюда намеренно не
  // применяются — см. шапку файла.
  if (READ_TOOLS.has(toolName)) return true;

  // Правки файлов при выключенном тумблере правок — только руками.
  if (!allowEdits && EDIT_TOOLS.has(toolName)) return false;

  // Незнакомая форма Bash-вызова: что исполнится — неизвестно, спрашиваем.
  if (toolName === 'Bash' && bashCommand(input) === undefined) return false;

  const rule = ruleFor(toolName, input);
  if (rule && !(allowedRules ?? DEFAULT_ALLOWED).has(rule)) return false;

  return !guardedPatterns.some((pattern) => matchesRule(pattern, toolName, input));
}
