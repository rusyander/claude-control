import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_BLOCKING_EVENTS, CODEX_HOOK_EVENTS } from '../../lib/codex-hook/codex-hook.ts';
import { buildCapabilities, type ConfigProvider } from '../types/types.ts';
import { codexHome, unimplementedPaths } from './config-dirs.ts';

/**
 * Один и тот же `~/.codex/config.toml` держит сразу три раздела — MCP,
 * переменные окружения и права; каждый правится хирургически, своим регионом.
 */
const codexConfigToml = (): string => join(codexHome(), 'config.toml');

/**
 * Значения глубины, задокументированные для `model_reasoning_effort`. Незнакомое
 * не передаётся вовсе: выдуманный уровень уронил бы прогон целиком, а «панель
 * ничего не сказала» значит «как настроено у пользователя» — рабочее состояние.
 */
const CODEX_EFFORTS = ['low', 'medium', 'high'];

/** Codex (OpenAI): AGENTS.md + ~/.codex/config.toml (MCP в [mcp_servers]). */
export const codexProvider: ConfigProvider = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  status: 'experimental',
  paths: unimplementedPaths('codex'),
  cli: { command: 'codex', windowsCommand: 'codex.cmd' },
  // Глобальный файл инструкций Codex задокументирован (~/.codex/AGENTS.md) →
  // раздел инструкций реально работает; override игнорируем (файл глобальный).
  instructionsFile: () => join(codexHome(), 'AGENTS.md'),
  // MCP-серверы Codex — таблицы [mcp_servers.<name>] в ~/.codex/config.toml.
  // Запись хирургическая (правится только регион mcp_servers), формат TOML.
  mcpConfig: { format: 'toml', path: codexConfigToml },
  // Переменные окружения Codex — таблица [shell_environment_policy.set] в том же
  // config.toml. Запись хирургическая: правится только ключ `set`, прочие ключи
  // политики (inherit/exclude/…) сохраняются по значениям.
  envConfig: { format: 'toml', path: codexConfigToml },
  // Хуки Codex (MAP 26) — `~/.codex/hooks.json`: ключ корня `hooks`, форма Claude
  // и Qwen, таймаут в секундах (lib/codex-hook.ts). Таблицы `[[hooks.X]]` в
  // config.toml CLI грузит тоже — панель их не правит, а показывает, что они есть.
  hooksConfig: {
    format: 'codex-json',
    path: () => join(codexHome(), 'hooks.json'),
    events: CODEX_HOOK_EVENTS.map((event) => event.name),
    blockingEvents: [...CODEX_BLOCKING_EVENTS],
    approvalRequired: true,
  },
  // Скиллы Codex (MAP 26) — документированный личный каталог `~/.agents/skills`
  // (общий с Kimi и OpenCode: они читают его тоже). `$CODEX_HOME/skills` codex
  // 0.160 ещё грузит, но документация его больше не называет — туда панель не
  // пишет, только сообщает. Имя скилла CLI ограничивает 64 знаками (живая проба),
  // длину описания не ограничивает — действует общий потолок 1024.
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(homedir(), '.agents', 'skills'),
    alsoLoadedFrom: () => [join(codexHome(), 'skills')],
  },
  // Плагины Codex (MAP 25): ставит, удаляет и подключает рынки сам CLI (`codex
  // plugin … --json`), кэш `plugins/cache/` панель только читает; включение —
  // ключ `enabled` таблицы `[plugins."имя@рынок"]` в config.toml.
  pluginsConfig: {
    format: 'codex-plugins',
    dir: () => join(codexHome(), 'plugins'),
    configPath: codexConfigToml,
    installedByCli: true,
  },
  // Права/аппрувы Codex — скалярные ключи КОРНЯ config.toml (`approval_policy` /
  // `sandbox_mode`). Запись хирургическая (upsertCodexRootScalar): правится только
  // сам корневой скаляр, одноимённые ключи внутри таблиц (`[profiles.x]`) не тронуты.
  permissionsConfig: {
    format: 'toml',
    path: codexConfigToml,
    // Корневые скаляры `approval_policy` / `sandbox_mode` — режим на весь CLI;
    // правила поимённо Codex не принимает.
    model: 'mode',
    decisions: [],
  },
  // Проектный уровень Codex (COMMON-2): задокументированы проектный AGENTS.md в
  // корне и проектный `.codex/config.toml` (приоритет проект > профиль > глобаль).
  // Файл тот же формат TOML, что и глобальный, — адаптер переиспользуется целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'toml', relativePath: '.codex/config.toml' },
    // Проектные хуки — `.codex/hooks.json` (грузятся, только когда проект
    // доверенный), проектные скиллы — `.agents/skills` в корне репозитория.
    hooks: { format: 'codex-json', relativePath: '.codex/hooks.json' },
    skills: { format: 'skill-md-dir', relativeDir: '.agents/skills' },
  },
  // Адрес модели у codex задаётся не переменной окружения, а таблицей
  // `model_providers` в том же config.toml (его документация: провайдер
  // описывается блоком с `base_url`/`wire_api`, и выбирается корневым ключом
  // `model_provider`). Значит контур сюда переносится — но не через env.
  endpointFile: {
    format: 'codex-toml',
    path: codexConfigToml,
    apiKind: 'openai-compat',
    // Ручка `/responses`, а не `/chat/completions`: `wire_api = "chat"` codex
    // больше не принимает и с таким конфигом не стартует вовсе (живая проба
    // 22.09.2026, `codex-cli 0.155.1`). Шлюз обслуживает его переводом на краю
    // (MAP D, `gateway/responses-bridge.ts`), поэтому codex — цель контура.
    wireApi: 'responses',
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.codex. Только проверка существования.
  configLocations: () => [codexHome()],
  // Группа Claude едет на прогон накладкой поверх конфига Codex (`-c`, корни
  // скиллов app-server, хуки надзирателем). Пока писатель накладки не
  // зарегистрирован в `domains/groups/run-layer/run-layer.ts`, прогон получает честное
  // «слоя нет», а не тумблер каталогов Claude.
  groupLayer: 'codex-overlay',
  // Рычаги экономии групп (план экономии чужих CLI, 22.10.2026, таблица §1). Ключи —
  // `-c` на запуск (`economy-run/codex.ts` → `kit/codex.ts`): конфиг человека цел.
  // Имена обоих ключей сверены со списком полей конфига в бинарнике codex-cli 0.155.1.
  groupEconomy: {
    channel: 'codex',
    support: {
      // `model_auto_compact_token_limit` — порог в токенах, тот же рычаг, что окно Claude.
      compactWindow: { support: 'native' },
      // `tool_output_token_limit` — ОДИН предел на все инструменты: из обоих рычагов
      // берётся больший, max(ceil(знаки оболочки / 4), токены чтения) (решение O2),
      // чтобы предел оболочки не урезал чтение. Ноль у любого из двух — ключа нет.
      // Ключ уходит, ТОЛЬКО если предел меньше 2500 токенов — собственного предела
      // Codex (`CODEX_DEFAULT_TOOL_OUTPUT_TOKENS`, замер 0.155.1): больший ключ не
      // ужал бы, а поднял предел (`economy-run/codex.ts`). Следствие: при чтении по
      // умолчанию (10 000 токенов) рычаг оболочки ОДИН ключа не даёт никогда — ключ
      // появляется, лишь когда чтение опущено ниже 2500 и оболочка не выше 9996 знаков.
      bashOutputChars: { support: 'native' },
      readOutputTokens: { support: 'native' },
      // `prompt_cache_options.ttl` есть лишь во вложенной документации, ключа конфига нет.
      cacheTtl: { support: 'impossible', note: 'economy-note-cache-implicit' },
      // Контекст редактора у Codex живёт только в TUI (`/ide`, модуль `tui/ide_context`
      // в бинарнике): app-server и `exec` его сами не подтягивают, а панель шлёт в
      // `turn/start` лишь текст (`live/codex-session.ts`).
      detachIde: { support: 'meaningless', note: 'economy-note-no-ide' },
      // Доставка — на младшей модели лестницы (`modelLadder`), а не на «Sonnet»
      // (`provider-chat/cascade/cheap-deliver.ts`); семейства нет в каталоге, через контур
      // нет строки карты для неё — модель работы; аккаунт её отверг — доставка заново
      // на модели работы. Глубина не выше глубины младшей ступени (`medium`).
      sonnetDeliver: { support: 'emulated' },
      // Пауза — по времени последней записи переписки Codex; решает панель.
      freshOnColdResume: { support: 'emulated' },
      // Скрытый пинг поменял бы отпечаток живой сессии, а наценки за запись у OpenAI нет.
      keepWarm: { support: 'disproportionate', note: 'economy-note-keep-warm-cost' },
      // Строка привычек — нейтральная часть той же строки, что у Claude.
      workHabits: { support: 'emulated' },
    },
  },
  // Ассистент Codex: API — OpenAI (ключ OPENAI_API_KEY), есть рабочий CLI (`codex`).
  // One-shot: `codex exec <prompt>` — неинтерактивный запуск (флаг задокументирован).
  assistant: {
    apiKind: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    cliRunnable: true,
    // Подбор модели (Т12): `-m/--model` задокументирован у самой `codex exec`, а
    // глубина — единственная среди всех чужих CLI — задаётся ключом конфига
    // `-c model_reasoning_effort=<low|medium|high>`. Кавычек из примеров
    // документации здесь нет намеренно: их снимает оболочка, а argv уходит без
    // неё, и `"high"` приехало бы в значение вместе с кавычками.
    //
    // Опции идут ДО позиционного промпта — так описан сам вызов
    // (`codex exec [OPTIONS] [PROMPT]`). Промпт — `-`, сам текст едет в stdin
    // (`oneShotStdin`; справочник CLI: «Use `-` to pipe the prompt from stdin»):
    // набор панели в `-c developer_instructions` (до 24 тыс.) и задание (до 24 тыс.)
    // вместе не влезают в командную строку Windows (32 767) — живой прогон 17.10
    // падал `spawn ENAMETOOLONG` на 32,6 тыс.
    oneShotStdin: true,
    oneShotArgs: (_prompt, run) => [
      'exec',
      ...(run?.model ? ['-m', run.model] : []),
      ...(CODEX_EFFORTS.includes(run?.effort ?? '')
        ? ['-c', `model_reasoning_effort=${run?.effort}`]
        : []),
      // «Разрешить правки» (`codex exec --help` 0.160: `-s, --sandbox
      // read-only|workspace-write|danger-full-access`). Выключено — только
      // чтение: спросить человека `exec` не может, молча править нельзя.
      ...(run?.allowEdits === undefined
        ? []
        : ['--sandbox', run.allowEdits ? 'workspace-write' : 'read-only']),
      '-',
    ],
    // В1: `codex app-server` (`turn/steer`, ≥ 0.99) — сообщение посреди хода уходит в тот же ход.
    liveServer: 'codex-app-server',
    // Переключатель правок доходит флагом `--sandbox` (см. `oneShotArgs`) и ответом app-server.
    editsControl: 'flag',
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Скрипты — раздел САМОЙ панели (произвольные файлы пользователя в её
    // каталоге hooks/), а не адаптер к чужому конфигу: ни CLI провайдера, ни его
    // формат тут не участвуют (COMMON-1). Поэтому `ready` у всех провайдеров;
    // claude-специфика раздела (песочница, отметка «вызывается хуком») гейтится
    // отдельно по своим возможностям `sandbox`/`hooks`.
    scripts: 'ready',
    // Скиллы и хуки (MAP 26): каталоги и форма сверены живым app-server
    // (`skills/list`, `hooks/list`); хук срабатывает только после одобрения в
    // `/hooks` — раздел об этом предупреждает. Плагины меняет сам CLI.
    skills: 'ready',
    hooks: 'ready',
    plugins: 'ready',
    analytics: 'ready',
    sandbox: 'unsupported',
  }),
  // Модели: каталог OpenAI (models.dev). Codex CLI работает с моделями OpenAI.
  modelVendors: ['openai'],
  // Лестница подбора (Т12): обе ступени — модели самого Codex, поэтому выбор
  // между ними не меняет ни вендора, ни доступа. `gpt-codex-spark` — младшая
  // (быстрая) кодовая модель, `gpt-codex` — старшая; семейства однородны, и
  // «свежайшая в семействе» означает ту же ступень следующего поколения.
  // Флагман общего назначения (`gpt`, `gpt-pro`) сюда не берём: подбор
  // существует, чтобы понижать, а не чтобы менять линейку.
  modelLadder: ['gpt-codex-spark', 'gpt-codex'],
};
