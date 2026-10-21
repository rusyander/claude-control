import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
import { MAIN_SYNC_ASK } from '../main-sync/main-sync.ts';
import { BASH_MAX_TIMEOUT_ENV, bashCeilingMs } from './bash-ceiling.ts';

export { bashCeilingsAt } from './bash-ceiling.ts';
import type {
  DropReason,
  GroupProfile,
  GroupProfileInput,
  GroupRunProfile,
  McpRole,
  ProfileMcpEntry,
  ServerSetRunProfile,
  SkillScopeInput,
} from './group-profile.types.ts';

export type * from './group-profile.types.ts';

/**
 * Лёгкий профиль запуска группы разделения (1.2, расход лимитов 17.10).
 *
 * Каждый вызов модели несёт список всех отложенных инструментов и указания
 * MCP-серверов: на 16.10 это 253 имени, из них 48 — подключения claude.ai
 * (почта, календарь, диск, документы) и 9 — второй коннектор трекера рядом с
 * основным. Группе, которая чинит задачу в копии, они не нужны ни разу, а
 * платит она за них на каждом из сотен вызовов.
 *
 * Профиль берёт трекер, хранилище кода и всё, о чём не знает (качество
 * важнее: незнакомый сервер мог поставить человек именно для работы); макеты —
 * только если в задачах есть макет; мессенджеры и дубль трекера снимает.
 * Понадобившийся сервер группа просит блоком `mcp` и получает следующим ходом
 * (`split-conveyor.ts`, `mcpExtra`).
 */

const ROLE_PATTERNS: [McpRole, RegExp][] = [
  ['tracker', /atlassian|jira|confluence|linear|youtrack|redmine|tracker/],
  ['forge', /gitlab|github|gitea|bitbucket/],
  ['design', /figma|penpot/],
  ['messenger', /telegram|slack|discord|whatsapp|gmail|outlook/],
];

/** Чем сервер себя выдаёт: имя, адрес, команда и её аргументы. */
function signature(entry: ProfileMcpEntry): string {
  const { url, command, args } = entry.config;
  const parts = [entry.id, url, command, ...(Array.isArray(args) ? args : [])];
  return parts
    .filter((part) => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

export function mcpRole(entry: ProfileMcpEntry): McpRole {
  const text = signature(entry);
  return ROLE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/**
 * Есть ли в задачах работа с макетом. Ссылка — наверняка; слова «макет»,
 * «дизайн», «вёрстка» — тоже: задача из трекера часто приходит ключом, а ссылка
 * на макет живёт в теле тикета, которого здесь нет. Лишний сервер макетов стоит
 * десяток имён, потерянный макет — переделку. Английские слова ищутся только
 * в прозе: путь `app/layouts/MainLayout` в задаче включал макеты группе без
 * макета (живой прогон 20.10 — +16 описаний навыков плагина в каждом вызове).
 * Путь — слово со слэшем или с точкой ПЕРЕД буквой (`design.tokens`); точка в
 * конце фразы — пунктуация: «Fix the layout.» — дизайн-задача, не путь.
 */
export function needsDesign(text: string): boolean {
  if (/figma\.com\/|макет|дизайн|в[её]рстк/i.test(text)) return true;
  const prose = text.replace(/\S*[/\\]\S*|\S*\.\w\S*|\b\w*[a-z][A-Z]\w*\b/g, ' ');
  return /\b(?:mock-?ups?|designs?|layouts?|pixel)\b/i.test(prose);
}

/**
 * Панель сама держит переходник к трекеру (`tools/mcp/atlassian.mjs`) — узкий,
 * на девять инструментов. Рядом с полным коннектором того же трекера он дубль;
 * один — он и есть трекер группы.
 */
function isPanelBridge(entry: ProfileMcpEntry): boolean {
  return /tools[\\/]mcp[\\/]/.test(signature(entry));
}

export function groupMcpProfile(input: GroupProfileInput): GroupProfile {
  // Имя модель пишет по памяти: «Figma» при сервере `figma` — та же просьба (ревью A1-F15).
  const extra = new Set(input.extra.map((name) => name.toLowerCase()));
  const design = needsDesign(input.tasksText);
  const trackers = input.entries.filter((entry) => mcpRole(entry) === 'tracker');
  const fullTracker = trackers.some((entry) => !isPanelBridge(entry));
  const kept: ProfileMcpEntry[] = [];
  const dropped: GroupProfile['dropped'] = [];
  for (const entry of input.entries) {
    const role = mcpRole(entry);
    const reason: DropReason | undefined =
      role === 'messenger'
        ? 'messenger'
        : role === 'design' && !design
          ? 'no-design-link'
          : role === 'tracker' && fullTracker && isPanelBridge(entry)
            ? 'duplicate-tracker'
            : undefined;
    if (reason && !extra.has(entry.id.toLowerCase())) dropped.push({ id: entry.id, reason });
    else kept.push(entry);
  }
  return { kept, dropped };
}

/**
 * Строка группе: без неё агент не знал бы, что сервер снят, и искал бы
 * обход (прямой REST, который правила запрещают без согласия).
 */
export function groupProfileNote(profile: GroupProfile, connectors: boolean): string {
  const kept = profile.kept.map((entry) => entry.id).join(', ') || 'none';
  const off = [
    ...profile.dropped.map((item) => item.id),
    ...(connectors ? [] : ['claude.ai (all claude.ai connectors)']),
  ].join(', ');
  return [
    `MCP servers in this run: ${kept}. Switched off to save the context of every call: ${off}.`,
    'If your task truly needs one of them, end your turn with this block and the panel connects ' +
      'it on your next turn:',
    `<${SPLIT_MCP_TAG}>`,
    'server: the server name from the list above',
    'why: what the task needs it for',
    `</${SPLIT_MCP_TAG}>`,
  ].join('\n');
}

/**
 * Лёгкий набор MCP группы в чужом CLI (6.1, Codex и Qwen Code): то же правило,
 * что у Claude, над серверами конфига этого CLI. Снятые уходят его выключателем
 * (`mcp_servers.<имя>.enabled=false` у Codex, `mcp.excluded` у Qwen), строка — в
 * системную; подключений claude.ai у них нет, о них строка молчит. Снимать
 * нечего — ни имён, ни строки.
 */
export function foreignGroupMcp(input: GroupProfileInput): { off: string[]; note?: string } {
  const profile = groupMcpProfile(input);
  if (profile.dropped.length === 0) return { off: [] };
  return { off: profile.dropped.map((item) => item.id), note: groupProfileNote(profile, true) };
}

/**
 * Навыки, которые группа получает с описанием всегда (1.3): маршрутизатор,
 * доставка задачи и ревью — то, что называет её задание (`SKILL_ROUTE_LINE`,
 * правило доставки), и то, без чего MR не сдать.
 */
export const GROUP_SKILLS = [
  'skill-map',
  'ticket-delivery-2',
  'prepare-mr',
  'changelog-builder',
  'mr-visual-report',
  'deep-review',
  'style-conformance-review',
  'resolving-merge-conflicts',
  'unit-integration-tests',
  'bug-regression-test',
  'playwright-e2e-tests',
  'log-forensics',
] as const;

/**
 * Навыки звена с описанием (L1.3, журнал 19.10: 37 описаний ≈ 10 тыс. токенов в
 * каждом вызове, звену нужны единицы). Подмножество `GROUP_SKILLS`: остальным —
 * только имя, вызвать их звено может и так. Работа, план и разбор — весь набор
 * группы: их задание шире одного навыка. Проверка правок — тоже `review`.
 */
export const STAGE_SKILLS: Partial<Record<CascadeStage, readonly GroupSkill[]>> = {
  review: [
    'skill-map',
    'deep-review',
    'style-conformance-review',
    'unit-integration-tests',
    'log-forensics',
  ],
  fix: [
    'skill-map',
    'ticket-delivery-2',
    'unit-integration-tests',
    'bug-regression-test',
    'playwright-e2e-tests',
    'resolving-merge-conflicts',
    'log-forensics',
  ],
  deliver: [
    'skill-map',
    'ticket-delivery-2',
    'prepare-mr',
    'changelog-builder',
    'mr-visual-report',
    'style-conformance-review',
    'resolving-merge-conflicts',
    'log-forensics',
  ],
};

type GroupSkill = (typeof GROUP_SKILLS)[number];

/** Навыки с описанием для звена; звено без своего набора — весь набор группы. */
export function stageSkills(stage: CascadeStage | undefined): readonly string[] {
  return (stage && STAGE_SKILLS[stage]) ?? GROUP_SKILLS;
}

/**
 * Звенья, которым MCP трекера, хранилища кода и макетов нужен только на чтение
 * (L1.2): план читает задачи, ревью и проверка правок — задачи и MR. Пишут в
 * трекер и в MR работа, правки и доставка.
 */
const READ_ONLY_STAGES: ReadonlySet<CascadeStage> = new Set(['plan', 'review']);

/**
 * Глаголы записи в именах инструментов MCP. Имён сервера до его запуска панель не
 * знает, поэтому запрет — шаблоном `*` по имени (CLI сверяет шаблон с именем
 * целиком и снимает подходящий инструмент из запроса вовсе, и из списка
 * отложенных тоже — замерено 2.1.286, `tools/qa/check-run-layers.mjs`, случай
 * «звено группы»). Глагол — в начале имени или после `_`, и за ним `_`:
 * `jira_create_issue`, `create_merge_request_note`. `merge` и `link` — только в
 * начале: `list_merge_requests` и `jira_get_link_types` — чтение. `batch` нет
 * вовсе: `jira_batch_get_changelogs` — тоже чтение.
 */
const WRITE_VERBS = [
  'create',
  'update',
  'delete',
  'add',
  'edit',
  'remove',
  'transition',
  'push',
  'fork',
  'upload',
  'publish',
  'approve',
  'unapprove',
  'resolve',
  'retry',
  'cancel',
  'play',
  'promote',
  'assign',
  'move',
  'execute',
] as const;
const START_ONLY_WRITE_VERBS = ['merge', 'link'] as const;

/** Строка звену только на чтение: почему инструментов записи нет и где они будут. */
const READ_ONLY_NOTE =
  'This stage reads the tracker, the code host and the designs only: their write tools are not ' +
  'in this run. Tracker and merge-request writes belong to the work, fix and delivery stages.';

/** Роли серверов, у которых запись — наружу: трекер, хранилище кода, макеты. */
const OUTWARD_ROLES: ReadonlySet<McpRole> = new Set(['tracker', 'forge', 'design']);

/** Имя сервера, как его пишет CLI в имени инструмента. */
function cliServerName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Правила `deny` на запись в MCP наружу для звена только на чтение; иначе пусто. */
export function readOnlyMcpDeny(
  kept: readonly ProfileMcpEntry[],
  stage: CascadeStage | undefined,
): string[] {
  if (!stage || !READ_ONLY_STAGES.has(stage)) return [];
  return kept
    .filter((entry) => OUTWARD_ROLES.has(mcpRole(entry)))
    .flatMap((entry) => {
      const server = `mcp__${cliServerName(entry.id)}__`;
      return [
        ...WRITE_VERBS.flatMap((verb) => [`${server}${verb}_*`, `${server}*_${verb}_*`]),
        ...START_ONLY_WRITE_VERBS.map((verb) => `${server}${verb}_*`),
      ];
    });
}

/**
 * Встроенные навыки CLI, которым в работе группы над задачей делать нечего:
 * графики, настройка самого CLI, расписания, авторство плагинов (замер 16.10,
 * 2.1.286 — 5,5 тыс. знаков описаний в каждом вызове). Ревью-навыки CLI
 * (`code-review`, `security-review`, `simplify`) остаются с описанием.
 */
const IDLE_BUNDLED = [
  'dataviz',
  'claude-api',
  'update-config',
  'schedule',
  'run',
  'loop',
  'keybindings-help',
  'fewer-permission-prompts',
  'workflow-authoring',
  'plugin-authoring',
  'init',
];

/** Звенья, которым макет не нужен и при макете в задачах: коммит, пуш, MR. */
const DESIGN_IDLE: ReadonlySet<CascadeStage | undefined> = new Set(['deliver', 'push']);

/**
 * Перечень навыков группы. Навыку вне группы остаётся ИМЯ (`name-only`), а не
 * выключение: агент по-прежнему может его вызвать — описание есть у
 * маршрутизатора `skill-map`, — а платит каждый вызов только за имя. Навыки
 * проекта не трогаются вовсе: их поставил сам репозиторий. Плагин макетов без
 * макета в задачах и плагин-мессенджер выключаются на этот прогон. Плагин
 * макетов выключается и в доставке: коммиту и MR макет не нужен, а `name-only`
 * навыкам плагина CLI не применяет ни по голому, ни по полному имени
 * (замерено 2.1.x: свой навык теряет описание, навык плагина — нет), так что
 * его описания (~6 тыс. знаков) уходят только вместе с плагином.
 */
export function skillSettings(
  skills: SkillScopeInput,
  design: boolean,
  stage?: CascadeStage,
): Record<string, unknown> {
  const keep = new Set<string>([...stageSkills(stage), ...skills.group]);
  const overrides = Object.fromEntries(
    [...skills.user, ...IDLE_BUNDLED]
      .filter((name) => !keep.has(name))
      .map((name) => [name, 'name-only']),
  );
  const offPlugins = skills.plugins.filter((plugin) => {
    const role = mcpRole({ id: plugin, config: {} });
    return role === 'messenger' || (role === 'design' && (!design || DESIGN_IDLE.has(stage)));
  });
  return {
    skillOverrides: overrides,
    ...(offPlugins.length > 0
      ? { enabledPlugins: Object.fromEntries(offPlugins.map((plugin) => [plugin, false])) }
      : {}),
  };
}

/** Просьба вернуть подключения claude.ai: их имён в файлах нет, просят по общему. */
function wantsConnectors(extra: readonly string[]): boolean {
  return extra.some((name) => /^claude[._]ai/i.test(name));
}

/** Переменная CLI (2.1.286): окно автосжатия, сильнее настройки `autoCompactWindow`. */
const COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
/**
 * Рычаги экономии (CLI 2.1.286, имена из самого CLI). Потолок чтения и срок кэша —
 * в `--settings`: так они сильнее того же ключа в личном settings.json, как потолок
 * Bash. Отвязка от IDE — окружением процесса: CLI смотрит её первой, до настроек.
 */
const READ_MAX_TOKENS_ENV = 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS';
const CACHE_TTL_ENV = 'CLAUDE_CODE_PROMPT_CACHE_TTL';
const AUTO_CONNECT_IDE_ENV = 'CLAUDE_CODE_AUTO_CONNECT_IDE';
/**
 * Напоминание «человек давно тебя не слышал» (CLI 2.1.286): после пяти ходов без
 * текста CLI дописывает его в каждый запрос, и модель тратит ход на отчёт, которого
 * в стадии никто не читает. Значение переменной сильнее способности модели (замер
 * 21.10: со способностью включено, `0` убирает) — поэтому окружением процесса.
 */
const SILENT_TURN_REMINDER_ENV = 'CLAUDE_CODE_SILENT_TURN_REMINDER';

/**
 * Привычки, которые удешевляют каждый следующий вызов (замер 20.10): окно
 * перечитывается целиком на каждом шаге, поэтому цепочка одиночных чтений и
 * чужой код, прочитанный ради поиска, оплачиваются десятки раз. Подагентов
 * строка не советует (F-10): их запуск — по согласию человека (директива L9),
 * а промпт подагента без меток хука `agent-prompt-guard` отклоняется — каждый
 * первый вызов оплачивался бы отказом и повтором.
 */
const WORK_HABITS_NOTE =
  'Economy (the human enabled it in the panel; every call re-sends this whole conversation): ' +
  'put independent reads and commands into one step — parallel tool calls or one `a; b; c` ' +
  'command — instead of a chain of single calls; read only what you will edit or judge. Keep ' +
  'output narrow: grep, line ranges, `git diff --stat` before a full diff. Work from the copy ' +
  'root with relative paths; do not `cd` — every directory change adds an environment note to ' +
  'the conversation.';

/**
 * Навыки ревью, которые звено работы или правок звало у себя (директива L3):
 * за ним конвейер всё равно заведёт ревью на потолке — проход внутри звена
 * оплачивался второй раз, на модели слабее той, что его повторит.
 */
export const REVIEW_SKILLS: readonly string[] = ['deep-review', 'style-conformance-review'];

/** Инструмент подагентов CLI: правило без скобок снимает его из запроса целиком. */
export const REVIEW_AGENT_DENY = 'Agent';

/**
 * Публикация, которую делает звено доставки (L3). Коммит не запрещён: дельту
 * ревью и доставку считают по коммитам ветки. Правило `deny` старше `ask`
 * брокера — пуш до доставки не доходит до карточки вовсе.
 */
export const DELIVERY_BASH_DENY: readonly string[] = [
  'Bash(git push*)',
  'Bash(git -C * push*)',
  'Bash(gh pr create*)',
  'Bash(glab mr create*)',
];

/** Инструменты MCP хранилища кода, которыми открывают MR / PR. */
const FORGE_OPEN_TOOLS = ['create_merge_request', 'create_pull_request'];

/** Инструменты MCP хранилища кода, которыми сливают MR / PR. */
const FORGE_MERGE_TOOLS = ['merge_merge_request', 'merge_pull_request'];

/** MCP-инструменты серверов наружу с этими именами — в форме правила CLI. */
function outwardTools(kept: readonly ProfileMcpEntry[], tools: readonly string[]): string[] {
  return kept
    .filter((entry) => OUTWARD_ROLES.has(mcpRole(entry)))
    .flatMap((entry) => tools.map((tool) => `mcp__${cliServerName(entry.id)}__${tool}`));
}

/**
 * Слияние MR — в каждом звене группы под `deny` (F-13): слияние запрещено
 * политикой владельца всегда, а держалось только на `ask` брокера, то есть на
 * одной карточке, которую человек мог подтвердить по ошибке.
 */
export function mergeDeny(kept: readonly ProfileMcpEntry[]): string[] {
  return outwardTools(kept, FORGE_MERGE_TOOLS);
}

/**
 * Чего звену не делать: за ним идут ревью и/или доставка; иначе пусто. Перед
 * ревью закрыт и `Agent` (F-09): ревью-полоса подагентом — тот же второй проход,
 * что и навык ревью, а без человека подагентов звену звать не с чьего согласия
 * (директива L9).
 */
export function aheadDeny(
  kept: readonly ProfileMcpEntry[],
  ahead: GroupProfileInput['ahead'],
): string[] {
  const review = ahead?.review
    ? [...REVIEW_SKILLS.map((name) => `Skill(${name})`), REVIEW_AGENT_DENY]
    : [];
  // Все серверы наружу, не только опознанные хранилищем кода: имя открытия MR
  // бывает только у форджа, а сервер «трекер + форж» опознаётся трекером.
  const deliver = ahead?.deliver
    ? [...DELIVERY_BASH_DENY, ...outwardTools(kept, FORGE_OPEN_TOOLS)]
    : [];
  return [...review, ...deliver];
}

/**
 * Перечень навыков звена (1.3) с навыками ревью, выключенными перед ревью (L3):
 * `deny` на `Skill(…)` в 2.1.286 лишь отказывает вызову, а описание остаётся в
 * каждом запросе — `off` снимает его из перечня (замер `check-run-layers.mjs`).
 */
function skillsWithAhead(input: GroupProfileInput): Record<string, unknown> {
  const base = input.skills
    ? skillSettings(input.skills, needsDesign(input.tasksText), input.stage)
    : {};
  if (!input.ahead?.review) return base;
  const overrides = (base.skillOverrides ?? {}) as Record<string, string>;
  return {
    ...base,
    skillOverrides: {
      ...overrides,
      ...Object.fromEntries(REVIEW_SKILLS.map((name) => [name, 'off'])),
    },
  };
}

function aheadNote(ahead: GroupProfileInput['ahead']): string | undefined {
  const parts = [
    ...(ahead?.review
      ? ['a review stage on the ceiling model reads this work — do not run a review pass here']
      : []),
    ...(ahead?.deliver
      ? ['a delivery stage pushes the branch and opens the MR — commit, but do not push or open it']
      : []),
  ];
  return parts.length > 0 ? `Later stages of this chain: ${parts.join('; ')}.` : undefined;
}
/**
 * Метка для хука конца хода блока «Тесты» (`tools/tests-hook.mjs`): автоматические
 * кейсы группа прогоняет один раз перед «доставлено» (`chat/tests-gate`), не в
 * конце каждого хода (решение владельца 19.10, пункт A).
 */
export const TESTS_RUNS_AT_DELIVERY_ENV = 'AGENTDECK_TESTS_RUNS_AT_DELIVERY';
const COMPACT_WINDOW_MIN = 100_000;
const COMPACT_WINDOW_MAX = 1_000_000;

/**
 * Окно сжатия групп: переменная панели `AGENTDECK_GROUP_COMPACT_WINDOW` (замер A/B
 * на одном запуске) сильнее рычага на странице настроек; ноль там — окно человека.
 */
export function groupCompactWindow(
  envRaw: string | undefined,
  setting: number | undefined,
): number | undefined {
  return compactWindowOf(envRaw) ?? (setting ? compactWindowOf(String(setting)) : undefined);
}

/**
 * Окно автосжатия группы из настройки панели (2.1, рычаг A/B, по умолчанию выключен):
 * `160000`, `160k`, `1M`. Вне границ, которые принимает CLI (100k–1M), и не число —
 * выключено: CLI с непонятным значением спорить не должен.
 */
export function compactWindowOf(raw: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(raw?.trim() ?? '');
  if (!match) return undefined;
  const unit = { '': 1, k: 1_000, m: 1_000_000 }[(match[2] ?? '').toLowerCase() as '' | 'k' | 'm'];
  const tokens = Math.round(Number(match[1]) * unit);
  return tokens >= COMPACT_WINDOW_MIN && tokens <= COMPACT_WINDOW_MAX ? tokens : undefined;
}

/**
 * Правила `ask` на хранилище кода и трекер группы — на весь сервер (журнал 19.10,
 * L6.2): в авторежиме CLI (`--permission-mode auto`) классификатор сам разрешил
 * продолжению группы ответить в тредах MR и переписать его описание, и до брокера
 * прав панели вызов не дошёл — строки вкладки «Группы» не решали ничего. Правило
 * `ask` сильнее режима (проверено живьём, `tools/qa/check-group-forge-ask.mjs`):
 * вызов идёт к брокеру, там чтение проходит само, а запись решает строка
 * `externalWrite`. На весь сервер, а не по именам записи: имён инструментов
 * сервера до его запуска панель не знает. Имя — как его пишет CLI: знаки вне
 * `[A-Za-z0-9_-]` становятся `_`.
 */
function outwardAsk(kept: readonly ProfileMcpEntry[]): { permissions: { ask: string[] } } {
  const servers = kept
    .filter((entry) => {
      const role = mcpRole(entry);
      return role === 'forge' || role === 'tracker';
    })
    .map((entry) => `mcp__${entry.id.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  return { permissions: { ask: [...servers, ...GROUP_DANGER_ASK, ...MAIN_SYNC_ASK] } };
}

/**
 * Команды оболочки, которые решает брокер прав, а не авторежим CLI (политика
 * владельца 19.10). В авторежиме (`--permission-mode auto`) до брокера доходит
 * только то, что задето правилом `ask`: раньше это был лишь принудительный пуш
 * (журнал 19.10 02:17:02, L7.12), и `git push origin main`, `git merge`,
 * `git branch -D`, `rm -rf src` проходили без карточки.
 *
 * Правило лишь ведёт вызов к брокеру; решает разбор команды
 * (`group-command.ts`): удаление настоящего, слияние, пуш в основную или
 * защищённую ветку и принудительный пуш — карточкой, пуш рабочей ветки, уборка
 * временного и чтение — сами, без человека. `*` в правиле CLI — любая строка,
 * пустая тоже; составную команду CLI проверяет по звеньям. Формы проверены
 * настоящим CLI в `tools/qa/check-group-forge-ask.mjs`.
 */
export const GROUP_DANGER_ASK: readonly string[] = [
  // Пуш любой формы: куда и как — решает разбор у брокера.
  'Bash(git push*)',
  'Bash(git -C * push*)',
  // Слияние, удаление веток, меток, копий, тайника.
  'Bash(git merge*)',
  'Bash(git -C * merge*)',
  'Bash(git branch *)',
  'Bash(git -C * branch *)',
  'Bash(git tag *)',
  'Bash(git -C * tag *)',
  'Bash(git worktree remove*)',
  'Bash(git -C * worktree remove*)',
  'Bash(git stash drop*)',
  'Bash(git stash clear*)',
  // Удаление файлов и каталогов.
  'Bash(rm *)',
  'Bash(rmdir *)',
  'Bash(rd *)',
  'Bash(del *)',
  'Bash(unlink *)',
  'Bash(Remove-Item *)',
  'Bash(find * -delete*)',
  'Bash(xargs *)',
  'Bash(sudo *)',
  // Базы: снос схемы и данных.
  'Bash(psql*)',
  'Bash(mysql*)',
  'Bash(sqlite3*)',
  'Bash(mongosh*)',
  'Bash(redis-cli*)',
  'Bash(dropdb*)',
  'Bash(docker exec *)',
  'Bash(* prisma migrate reset*)',
  // Слияние и удаление на форже: CLI форджа и прямой запрос к API.
  'Bash(gh *)',
  'Bash(glab *)',
  'Bash(curl *merge*)',
  'Bash(curl *DELETE*)',
];

/**
 * Личные секции (память копии, каталог, git) — из системного промпта в первое
 * сообщение (X1, CLI 2.1.286). Замер 22.10.2026 настоящим API, Opus 5.5, две
 * копии одной группы подряд: второй старт читал из кэша 9 468 токенов без флага
 * и 12 544 с ним при строке о тестах без путей (запись 18 110 → 14 860); один
 * флаг без той строки не давал ничего. Дата и сведения о среде и без флага
 * идут сообщением — системный промпт полночь не меняет. С `--system-prompt`
 * (контур) CLI флаг не применяет.
 */
const SHARED_PREFIX_ARG = '--exclude-dynamic-system-prompt-sections';

/** Профиль в виде, в каком его кладёт в запуск реестр прогонов. */
export function groupRunProfile(input: GroupProfileInput): ServerSetRunProfile {
  const profile = groupMcpProfile(input);
  const connectors = wantsConnectors(input.extra);
  const outward = outwardAsk(profile.kept);
  const readOnly = readOnlyMcpDeny(profile.kept, input.stage);
  const economy = input.economy;
  const deny = [...readOnly, ...aheadDeny(profile.kept, input.ahead), ...mergeDeny(profile.kept)];
  const ahead = aheadNote(input.ahead);
  const notes = [
    groupProfileNote(profile, connectors),
    ...(readOnly.length > 0 ? [READ_ONLY_NOTE] : []),
    ...(ahead ? [ahead] : []),
    ...(economy?.workHabits ? [WORK_HABITS_NOTE] : []),
  ];
  return {
    args: ['--strict-mcp-config', SHARED_PREFIX_ARG],
    env: {
      ...(connectors ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
      [TESTS_RUNS_AT_DELIVERY_ENV]: '1',
      ...(input.compactWindow ? { [COMPACT_WINDOW_ENV]: String(input.compactWindow) } : {}),
      ...(input.heavyQueue ? { [HEAVY_QUEUE_ENV]: input.heavyQueue.dir } : {}),
      ...(economy?.detachIde ? { [AUTO_CONNECT_IDE_ENV]: 'false' } : {}),
      ...(economy?.workHabits ? { [SILENT_TURN_REMINDER_ENV]: '0' } : {}),
    },
    mcp: {
      ids: profile.kept.map((entry) => entry.id),
      config: {
        mcpServers: Object.fromEntries(profile.kept.map((entry) => [entry.id, entry.config])),
      },
    },
    note: notes.join('\n'),
    settings: {
      env: {
        [BASH_MAX_TIMEOUT_ENV]: String(bashCeilingMs(input.bashCeilings)),
        ...(economy?.readOutputTokens
          ? { [READ_MAX_TOKENS_ENV]: String(economy.readOutputTokens) }
          : {}),
        ...(economy?.cacheTtl ? { [CACHE_TTL_ENV]: economy.cacheTtl } : {}),
      },
      // Ключ настроек, а не `BASH_MAX_OUTPUT_LENGTH`: переменная в 2.1.286 задаёт
      // лишь окно дочитывания, сколько ответа попадает в разговор — этот ключ.
      ...(economy?.bashOutputChars ? { bashOutputMaxChars: economy.bashOutputChars } : {}),
      ...skillsWithAhead(input),
      ...groupHooks(input),
      permissions: {
        ...outward.permissions,
        ...(deny.length > 0 ? { deny } : {}),
      },
    },
  };
}

/**
 * Инструменты правки и оболочка — лёгкому чату вопросов о ходе групп они
 * запрещены: правило человека `allow` для оболочки пускало её без вопроса, и
 * «ничего не меняет» было обещанием без запрета (ревью A1-F10/B1-F18).
 */
const STATUS_DENIED_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'];

/**
 * Профиль лёгкого чата вопросов о ходе групп (5.1). Ответ берётся из сводки
 * групп в сообщении, поэтому прогону не нужно ничего сверх чтения: ни одного
 * MCP-сервера, ни подключений claude.ai, ни описаний навыков, ни плагинов, ни
 * инструментов правки, ни оболочки. Навыкам остаётся имя — вызвать их можно и так.
 */
export function statusRunProfile(skills: SkillScopeInput): ServerSetRunProfile {
  const named = new Set([...GROUP_SKILLS, ...IDLE_BUNDLED, ...skills.user, ...skills.group]);
  return {
    args: ['--strict-mcp-config'],
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    mcp: { ids: [], config: { mcpServers: {} } },
    note:
      'This run has no MCP servers, no edit tools and no shell: it answers questions about split groups ' +
      'from the summary in the message.',
    settings: {
      skillOverrides: Object.fromEntries([...named].map((name) => [name, 'name-only'])),
      ...(skills.plugins.length > 0
        ? { enabledPlugins: Object.fromEntries(skills.plugins.map((plugin) => [plugin, false])) }
        : {}),
      permissions: { deny: STATUS_DENIED_TOOLS },
    },
  };
}

/**
 * Профиль обычного чата при инициативе разделения (5.2): прогон и серверы как
 * были, сверху только хук списка задач без описаний — разбор доски перед
 * разделением идёт заголовками, описание читается у отобранных задач.
 */
export function chatRunProfile(input: { boardHook: string }): GroupRunProfile {
  return { args: [], env: {}, note: '', settings: { hooks: boardHooks(input.boardHook) } };
}

/**
 * Профиль под маршрутом, который сам решает MCP (контур, локальная модель):
 * серверы, флаг, переменная подключений claude.ai и строка о серверах — его;
 * настройки (запрет правок, хуки, навыки) и прочие переменные остаются.
 */
export function withoutMcp(profile: GroupRunProfile): GroupRunProfile {
  const env = Object.fromEntries(
    Object.entries(profile.env).filter(([name]) => name !== 'ENABLE_CLAUDEAI_MCP_SERVERS'),
  );
  return { args: [], env, note: '', settings: profile.settings };
}

/** Хуки группы одним полем `hooks`: два хука одного события — один массив. */
function groupHooks(input: GroupProfileInput): { hooks?: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  const add = (event: string, entry: unknown) => (hooks[event] ??= []).push(entry);
  if (input.trackerHook) {
    for (const [event, entries] of Object.entries(trackerHooks(input.trackerHook))) {
      for (const entry of entries) add(event, entry);
    }
  }
  if (input.boardHook) {
    for (const [event, entries] of Object.entries(boardHooks(input.boardHook))) {
      for (const entry of entries) add(event, entry);
    }
  }
  if (input.heavyQueue) {
    for (const [event, entries] of Object.entries(heavyQueueHooks(input.heavyQueue.hook))) {
      for (const entry of entries) add(event, entry);
    }
  }
  return Object.keys(hooks).length > 0 ? { hooks } : {};
}

/** Переменная прогона: каталог очереди тяжёлых шагов, общий для всех групп машины. */
export const HEAVY_QUEUE_ENV = 'AGENTDECK_HEAVY_QUEUE_DIR';

/**
 * Очередь тяжёлых шагов (3.2): до тяжёлой команды Bash хук ждёт места (до
 * 30 мин — сам он уходит раньше, через 25), после неё и после провала отдаёт.
 * Команду не переписывает — права решает CLI по исходной. `unit` — во что CLI
 * читает таймаут: Claude — секунды, Qwen Code — миллисекунды (1000). Матчер
 * `Bash` Qwen Code 0.25 сводит к своей `run_shell_command` (живьём 17.10).
 */
export function heavyQueueHooks(command: string, unit = 1): Record<string, unknown[]> {
  const entry = (seconds: number) => ({
    matcher: 'Bash',
    hooks: [{ type: 'command', command, timeout: seconds * unit }],
  });
  return {
    PreToolUse: [entry(1800)],
    PostToolUse: [entry(10)],
    PostToolUseFailure: [entry(10)],
  };
}

/** Матчер хука трекера: только запись. Повторён в `tools/tracker-brief-hook.mjs`. */
const TRACKER_WRITE_MATCHER =
  'mcp__.*__jira_(transition_issue|assign_issue|update_issue|add_comment|edit_comment)';

/**
 * Хук свёртки ответов трекера (2.3): смена статуса и назначение отвечали задачей
 * целиком, и каждый вызов после перечитывал её. Хуки из `--settings` CLI
 * складывает с личными, а не подменяет (`check-group-tracker-brief.mjs`).
 */
function trackerHooks(command: string): Record<string, unknown[]> {
  return {
    PostToolUse: [
      { matcher: TRACKER_WRITE_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}

/** Матчер хука списка задач: поиск, доска, спринт. Повторён в `tools/board-fields-hook.mjs`. */
const BOARD_LIST_MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';

/**
 * Хук списка задач (5.2): без названных полей трекер отдаёт каждую задачу с
 * описанием, и разбор доски вытягивал сотни тысяч знаков. До вызова хук
 * подставляет короткий набор полей; вызов, назвавший поля, не трогает.
 */
function boardHooks(command: string): Record<string, unknown[]> {
  return {
    PreToolUse: [
      { matcher: BOARD_LIST_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}
