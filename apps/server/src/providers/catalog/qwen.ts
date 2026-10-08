import { join } from 'node:path';
import { QWEN_HOOK_EVENTS } from '../../lib/qwen-hook/qwen-hook.ts';
import { buildCapabilities, type ConfigProvider } from '../types/types.ts';
import { qwenHome, unimplementedPaths } from './config-dirs.ts';

/** MCP, права и хуки Qwen лежат в одном `settings.json`, каждый — своим ключом. */
const qwenSettings = (): string => join(qwenHome(), 'settings.json');

/**
 * Qwen Code: QWEN.md + `~/.qwen/settings.json` (форк Gemini CLI).
 *
 * ФОРК, НО НЕ КОПИЯ. Структура каталога и ключ `mcpServers` совпадают с Gemini —
 * эти адаптеры (`json`, `dotenv`, файл инструкций) переиспользуются целиком. А вот
 * ПРАВА разъехались, и брать у Gemini их нельзя:
 *  - режим аппрувов у Qwen — `tools.approvalMode` (у Gemini `general.defaultApprovalMode`);
 *  - списки инструментов — `permissions.allow` / `ask` / `deny` (у Gemini
 *    `coreTools`/`excludeTools`; у Qwen старые `tools.core`/`allowed`/`exclude`
 *    ПОМЕЧЕНЫ УСТАРЕВШИМИ и мигрируются в `permissions.*` — панель их не пишет).
 * Отсюда собственный формат `qwen-json`.
 *
 * Каталог конфигурации переносится переменной `QWEN_HOME` (см. `qwenHome()`).
 */
export const qwenProvider: ConfigProvider = {
  id: 'qwen',
  name: 'Qwen Code',
  status: 'experimental',
  paths: unimplementedPaths('qwen'),
  cli: { command: 'qwen', windowsCommand: 'qwen.cmd' },
  // Глобальный файл инструкций (контекстный файл) задокументирован:
  // `~/.qwen/QWEN.md` — «you, across all your projects»; проектный — QWEN.md в
  // корне репозитория.
  instructionsFile: () => join(qwenHome(), 'QWEN.md'),
  // MCP-серверы Qwen — объект `mcpServers` в settings.json, форма как у Gemini
  // (command/args/env/cwd, url для SSE, httpUrl для streamable HTTP) → общий
  // JSON-адаптер без изменений.
  mcpConfig: { format: 'json', path: qwenSettings },
  // Переменные окружения — задокументированный `.env`: глобальный
  // `<QWEN_HOME>/.env`, проектный `<проект>/.qwen/.env` (он в порядке загрузки
  // ПЕРВЫЙ и рекомендован докой). Правка построчная, как у Gemini.
  envConfig: { format: 'dotenv', path: () => join(qwenHome(), '.env') },
  // Права/аппрувы — свой формат (см. комментарий выше): `tools.approvalMode` +
  // списки правил `permissions.allow` / `ask` / `deny`.
  permissionsConfig: {
    format: 'qwen-json',
    path: qwenSettings,
    // Три списка правил `permissions.allow|ask|deny` — решения все три.
    model: 'rules',
    decisions: ['allow', 'ask', 'deny'],
  },
  // Хуки Qwen (QWEN-1) — ключ КОРНЯ `hooks` в том же settings.json: событие →
  // массив групп с матчером и действиями. Панель ведёт действия типа `command`
  // (см. lib/qwen-hook.ts); таймаут там в МИЛЛИСЕКУНДАХ.
  hooksConfig: {
    format: 'qwen-json',
    path: qwenSettings,
    // Имена восемнадцати событий ведёт сам адаптер формата — здесь ссылка на
    // его список, а не вторая копия.
    events: QWEN_HOOK_EVENTS.map((event) => event.name),
    // Остановить действие (код выхода 2) документация называет у тех же трёх
    // событий, что и у Kimi. Остальные пятнадцать перечислены наблюдательными
    // НАРОЧНО: недообещать блокировку у цели — сторона строгости, а обещанная и
    // не состоявшаяся означала бы молча снятый запрет (инвариант 6).
    blockingEvents: ['UserPromptSubmit', 'PreToolUse', 'Stop'],
  },
  // Скиллы Qwen (QWEN-2) — папка на скилл со `SKILL.md`: личные
  // `~/.qwen/skills/`, проектные `<проект>/.qwen/skills/`. Обязательные поля
  // шапки те же два (`name`, `description`), прочие (`priority`, `paths`,
  // `user-invocable`, `disable-model-invocation`) панель сохраняет как чужие.
  skillsConfig: { format: 'skill-md-dir', dir: () => join(qwenHome(), 'skills') },
  // Правила (MAP 24): каталог `~/.qwen/rules/*.md`, рекурсивно; `paths:` во
  // frontmatter — условное правило, без него — постоянное. Формат по документу
  // CLI `docs/users/features/rules.md`, сверен с qwen-code 0.25.0.
  rulesConfig: { format: 'qwen-md', dir: () => join(qwenHome(), 'rules') },
  // Слэш-команды — тот же формат, что у Gemini (форк документацию сохранил):
  // `~/.qwen/commands` с файлами `.toml`, подкаталог даёт `/namespace:command`.
  commandsConfig: {
    format: 'toml-prompt',
    dir: () => join(qwenHome(), 'commands'),
    namespaceSeparator: ':',
  },
  // Расширения (MAP 25): `<QWEN_HOME>/extensions/<имя>/qwen-extension.json`.
  // Манифесты панель читает сама; ставит, включает, выключает и удаляет — только
  // `qwen extensions install --consent|enable|disable --scope user|uninstall`.
  // Хранилище `extension-store/` и `extension-enablement.json` — внутреннее
  // устройство CLI, панель их не пишет. Сверено с qwen-code 0.25.0.
  pluginsConfig: {
    format: 'qwen-extensions',
    dir: () => join(qwenHome(), 'extensions'),
    installedByCli: true,
  },
  // Проектный уровень: проектный QWEN.md в корне, `<проект>/.qwen/settings.json`
  // (MCP и права; проектные настройки перекрывают пользовательские) и
  // `<проект>/.qwen/.env`. Форматы те же, что у глобальных разделов.
  projectConfig: {
    instructions: 'QWEN.md',
    mcp: { format: 'json', relativePath: '.qwen/settings.json' },
    env: { format: 'dotenv', relativePath: '.qwen/.env' },
    permissions: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
    // Проектные хуки и скиллы задокументированы ровно там же, где проектные
    // настройки: `hooks` в `.qwen/settings.json` (док прямо говорит, что
    // проектные хуки требуют доверенной папки) и каталог `.qwen/skills/`.
    hooks: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
    skills: { format: 'skill-md-dir', relativeDir: '.qwen/skills' },
    // Каталог правил проекта: CLI 0.25 читает `<проект>/.qwen/rules` вслед за
    // глобальным `~/.qwen/rules`, только если папка доверенная (`loadRulesFromDir`
    // в его бандле под `folderTrust`). Формат тот же, что у глобального.
    instructionsRules: { format: 'qwen-md', relativeDir: '.qwen/rules' },
  },
  // Детект «конфиг найден» (Ф7): каталог конфигурации. Только проверка существования.
  configLocations: () => [qwenHome()],
  // Группа Claude едет на прогон файлом системных настроек
  // (`QWEN_CODE_SYSTEM_SETTINGS_PATH`, живьём на 0.25 — provider-formats).
  groupLayer: 'qwen-system-settings',
  // Ассистент Qwen: модельное API — OpenAI-совместимое (OPENAI_API_KEY +
  // OPENAI_BASE_URL/OPENAI_MODEL), у ModelStudio/DashScope — DASHSCOPE_API_KEY.
  // One-shot: `qwen -p <промпт>` — задокументированный headless-режим.
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY'],
    cliRunnable: true,
    // «Разрешить правки» (`qwen --help` 0.25.0: `--approval-mode
    // plan|default|auto-edit|auto|yolo`). Включено — `yolo`, как живой ход, где
    // каждая просьба получает «да»; выключено — `default`: в `-p` спросить
    // некого, и просьба отклоняется, даже если в настройках стоит `yolo`.
    oneShotArgs: (prompt, run) => [
      ...(run?.allowEdits === undefined
        ? []
        : ['--approval-mode', run.allowEdits ? 'yolo' : 'default']),
      '-p',
      prompt,
    ],
    // В1: `qwen serve` (≥ 0.19) — сообщение посреди хода уходит в тот же ход.
    liveServer: 'qwen-serve',
    // Переключатель правок доходит флагом `--approval-mode` и ответом `qwen serve`.
    editsControl: 'flag',
  },
  // Свой эндпоинт: Qwen Code документирует ДВА протокола сразу — совместимый с
  // OpenAI (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`) и Anthropic
  // (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`), — и сам же
  // говорит, что берёт их из `.env` (порядок: `.qwen/.env` → `.env` → домашние).
  // Поэтому профиль обоих видов сюда переносится.
  endpointConfig: {
    'openai-compat': {
      baseUrlEnv: 'OPENAI_BASE_URL',
      modelEnv: 'OPENAI_MODEL',
      credentialEnv: 'OPENAI_API_KEY',
    },
    anthropic: {
      baseUrlEnv: 'ANTHROPIC_BASE_URL',
      modelEnv: 'ANTHROPIC_MODEL',
      credentialEnv: 'ANTHROPIC_API_KEY',
    },
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // Права: `tools.approvalMode` + `permissions.allow/ask/deny` (формат qwen-json).
    permissions: 'ready',
    // Переменные окружения — файл `.env` (глобальный и проектный).
    env: 'ready',
    chat: 'ready',
    // Проектный уровень: QWEN.md + `.qwen/settings.json` + `.qwen/.env`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Хуки (QWEN-1) — ключ `hooks` в settings.json; скиллы (QWEN-2) — каталог
    // `skills/` с папками SKILL.md. Оба формата разобраны по документации.
    skills: 'ready',
    hooks: 'ready',
    // Команды: каталог `commands/*.toml`, формат унаследован от Gemini.
    commands: 'ready',
    // Расширения (MAP 25): `extensions/<имя>/qwen-extension.json` — раздел
    // «Плагины», меняется только командами `qwen extensions …`.
    plugins: 'ready',
    // Правила: глобальный каталог `~/.qwen/rules/` (`rulesConfig`). Проектный
    // `<проект>/.qwen/rules/` CLI читает только в доверенной папке — вкладки
    // проекта у раздела пока нет.
    rules: 'ready',
    analytics: 'ready',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Alibaba (models.dev) — семейство Qwen.
  modelVendors: ['alibaba'],
  // Подбора модели (Т12) у Qwen НЕТ, и это решение, а не пробел: флаг `--model`
  // задокументирован, но семейства каталога неоднородны — в `qwen` лежат разом
  // `flash`, `plus` и `max`, и «свежайшая в семействе» завтра означала бы `max`,
  // то есть понижение молча стало бы повышением. Однородного слабого семейства
  // текущего поколения у вендора нет.
};
