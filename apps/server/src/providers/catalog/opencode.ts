import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { opencodeConfigDir, opencodeConfigFile, unimplementedPaths } from './config-dirs.ts';

/** OpenCode: AGENTS.md + opencode.json. */
export const opencodeProvider: ConfigProvider = {
  id: 'opencode',
  name: 'OpenCode',
  status: 'experimental',
  paths: unimplementedPaths('opencode'),
  cli: { command: 'opencode', windowsCommand: 'opencode.cmd' },
  // Глобальный файл инструкций OpenCode — обычный markdown
  // ~/.config/opencode/AGENTS.md (тот же де-факто стандарт, что у Codex).
  instructionsFile: () => join(opencodeConfigDir(), 'AGENTS.md'),
  // MCP-серверы OpenCode — ключ `mcp` внутри ~/.config/opencode/opencode.json.
  // Форма ИНАЯ, чем у mcpServers: { type:'local', command:[cmd,...args],
  // environment } либо { type:'remote', url, headers }. Отдельный адаптер формата
  // `opencode-json`; правится только ключ `mcp`, прочие ключи файла ($schema,
  // model, agents, …) и неизвестные поля сервера (включая `enabled`) сохраняются.
  mcpConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
  },
  // Права OpenCode (OPENCODE-1) — ключ `permission` того же opencode.json:
  // уровень `allow` | `deny` | `ask` у задокументированных инструментов (`edit`,
  // `bash`, `webfetch`), а у `bash` вместо уровня допустима КАРТА ШАБЛОНОВ команд
  // (`{"*":"ask","git *":"allow","git push *":"deny"}`). Правится только ключ
  // `permission`; прочие ключи файла и не ведомые панелью записи внутри
  // `permission` сохраняются (см. lib/opencode-permission.ts).
  permissionsConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
  },
  // Хуки OpenCode (OPENCODE-3) — ключ `experimental.hook` того же opencode.json:
  // два события (`file_edited` — карта «шаблон файлов → действия»,
  // `session_completed` — массив действий), действие = argv-МАССИВ `command` +
  // необязательные `environment`.
  //
  // РАЗДЕЛ ТОЛЬКО ДЛЯ ЧТЕНИЯ с 2026-07-25. Сверка форматов (IDEA-3) поймала, а
  // проверка по документации подтвердила: ключа `experimental.hook` больше нет ни
  // в справочнике конфигурации OpenCode, ни в опубликованной схеме
  // `https://opencode.ai/config.json`, причём у `experimental` там
  // `additionalProperties: false` — то есть схема такой ключ ОТВЕРГАЕТ.
  // Задокументированный способ повесить действие на событие теперь один —
  // ПЛАГИНЫ (`plugin` + каталог `plugins/`), и он у панели уже есть отдельным
  // разделом. Писать ключ, которого нет ни в документации, ни в схеме, — гадание
  // о чужом формате, а оно запрещено. Читать продолжаем: у человека такой ключ
  // мог остаться от прежних версий, и прятать его было бы хуже.
  // Опишут ключ обратно → снять `writeDisabledReason`, адаптер трогать не нужно.
  hooksConfig: {
    format: 'opencode-json',
    path: opencodeConfigFile,
    writeDisabledReason:
      'Ключ experimental.hook исчез из справочника конфигурации OpenCode и из опубликованной схемы (проверено 25 июля 2026), а `experimental` в схеме закрыт для чужих ключей. Панель больше не пишет его: задокументированный способ повесить действие на событие — плагины.',
  },
  // Плагины OpenCode (OPENCODE-4) — два задокументированных способа сразу:
  // КАТАЛОГ файлов JS/TS `~/.config/opencode/plugins/`, которые CLI подхватывает
  // при старте, и массив имён npm-пакетов `plugin` в opencode.json (ключ
  // подтверждён и страницей плагинов, и опубликованной схемой конфигурации).
  // Каталог ведётся файловым менеджером с той же защитой путей, что у правил
  // Cursor; список npm правится с сохранением всех прочих ключей файла.
  pluginsConfig: {
    format: 'opencode-plugins',
    dir: () => join(opencodeConfigDir(), 'plugins'),
    configPath: opencodeConfigFile,
  },
  // Скиллы OpenCode (OPENCODE-5) — каталог `~/.config/opencode/skills/`, папка на
  // скилл, внутри `SKILL.md` с YAML-шапкой. Понятие то же, что у Claude, но поля
  // шапки свои: распознаются `name` (обязательное), `description` (обязательное),
  // `license`, `compatibility`, `metadata`; всё прочее CLI игнорирует, а панель
  // сохраняет. Путь каталога НЕ следует за `OPENCODE_CONFIG` — та переменная
  // переносит только сам файл конфигурации.
  // Каталоги `~/.claude/skills` и `~/.agents/skills` OpenCode тоже читает,
  // поэтому уже готовые скиллы Claude в нём работают без переноса. Панель
  // сообщает об этом и НИЧЕГО туда не пишет: ими ведает раздел скиллов Claude.
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(opencodeConfigDir(), 'skills'),
    alsoLoadedFrom: () => [
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.agents', 'skills'),
    ],
  },
  // Слэш-команды OpenCode — задокументированы ДВА источника сразу: каталог
  // `~/.config/opencode/commands/` с файлами `.md` (шапка `description`, `agent`,
  // `model`; имя файла = имя команды) и ключ `command` в самом конфиге, где у
  // записи есть `template` и `description`. Читаем оба, иначе список соврёт.
  // Вложенность подкаталогов в документации не описана → её не разбираем.
  commandsConfig: {
    format: 'md-frontmatter',
    dir: () => join(opencodeConfigDir(), 'commands'),
    configPath: opencodeConfigFile,
  },
  // Переменных окружения у OpenCode НЕТ (OPENCODE-2, `env = unsupported`): по
  // документации он умеет только подстановку `{env:ПЕРЕМЕННАЯ}` внутри
  // opencode.json, то есть ЧИТАЕТ уже заданное окружение процесса, и своего
  // `.env` не загружает (это открытая просьба к разработчикам, а не готовая
  // возможность). Файл, который никто не читает, панель создавать не станет →
  // `envConfig` не задан, раздел скрыт.
  // Проектный уровень OpenCode (COMMON-2 + OPENCODE-1): задокументированы
  // проектный AGENTS.md и `<проект>/opencode.json` — тот же формат
  // `opencode-json`, поэтому оба адаптера (MCP и права) переиспользуются целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'opencode-json', relativePath: 'opencode.json' },
    permissions: { format: 'opencode-json', relativePath: 'opencode.json' },
    // Хуки проекта (OPENCODE-3): тот же ключ `experimental.hook` того же формата
    // в проектном opencode.json — адаптер переиспользуется целиком.
    hooks: { format: 'opencode-json', relativePath: 'opencode.json' },
    // Плагины проекта (OPENCODE-4): задокументированный каталог
    // `<проект>/.opencode/plugins/` плюс массив `plugin` в проектном конфиге.
    plugins: {
      format: 'opencode-plugins',
      relativeDir: '.opencode/plugins',
      relativePath: 'opencode.json',
    },
    // Скиллы проекта (OPENCODE-5): задокументированный каталог
    // `<проект>/.opencode/skills/` — тот же формат, адаптер переиспользуется.
    skills: { format: 'skill-md-dir', relativeDir: '.opencode/skills' },
  },
  // Детект «конфиг найден» (Ф7): задокументированы оба варианта размещения —
  // XDG-каталог ~/.config/opencode и ~/.opencode. Достаточно любого из них.
  // NB: пишем ВСЕГДА в канонический XDG-путь (см. instructionsFile/mcpConfig) —
  // выбирать файл по факту существования значило бы угадывать, куда смотрит CLI.
  // Плюс сам файл конфигурации, ЕСЛИ он перенесён `OPENCODE_CONFIG`: каталога
  // `~/.config/opencode` у такого пользователя может не быть вовсе.
  configLocations: () => {
    const locations = [opencodeConfigDir(), join(homedir(), '.opencode')];
    const file = opencodeConfigFile();
    if (dirname(file) !== opencodeConfigDir()) locations.push(file);
    return locations;
  },
  // Ассистент OpenCode: OpenAI-совместимый API (ключ настраивается на стороне
  // самого OpenCode, стандартной единой env-переменной нет → apiKeyEnvVars пуст),
  // есть рабочий CLI (`opencode`) → раннер `cli`, пока ключ не задан в панели.
  // OPENCODE-7: задокументированный one-shot — подкоманда `run`, промпт идёт
  // ПОЗИЦИОННЫМ аргументом в конце (`opencode run "<текст>"`); стандартный ввод
  // CLI не поддерживает, поэтому передать промпт можно только так. Промпт —
  // ОТДЕЛЬНЫЙ элемент argv, никакой сборки строки для оболочки.
  // IDEA-8: у OpenCode есть и ЗАДОКУМЕНТИРОВАННЫЙ локальный сервер
  // (`opencode serve --port <n> --hostname <адрес>`) с сессиями — диалог держит
  // сам CLI, панель шлёт только новое сообщение. Панель пробует его ПЕРВЫМ и при
  // любой заминке молча возвращается к one-shot (см. domains/opencode-serve.ts).
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: [],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['run', prompt],
    sessionServer: 'opencode',
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // OPENCODE-1: права — ключ `permission` в opencode.json (глобальном и проектном).
    permissions: 'ready',
    // OPENCODE-2: у OpenCode НЕТ места для переменных окружения — только
    // подстановка `{env:ПЕРЕМЕННАЯ}` из уже заданного окружения процесса.
    // Значит раздел не «в разработке», а неприменим → скрыт (unsupported).
    env: 'unsupported',
    // OPENCODE-7: one-shot задокументирован — `opencode run "<промпт>"`. Basic-чат
    // работает через тот же раннер, что у codex/gemini/aider, и остаётся с
    // пометкой «экспериментально»: `opencode` на этой машине не установлен.
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // OPENCODE-5: скиллы — каталог `skills/` (глобальный и проектный), папка на
    // скилл со `SKILL.md`. Понятие то же, что у Claude; поля шапки и правила
    // имени — свои, задокументированные.
    skills: 'ready',
    // OPENCODE-3: хуки — ключ `experimental.hook` в opencode.json (глобальном и
    // проектном). Модель СВОЯ, не claude-овская: два события и argv-действия.
    // Раздел честно помечен «экспериментально у самого OpenCode» — ключ лежит
    // под `experimental`, который OpenCode объявляет нестабильным.
    hooks: 'ready',
    // OPENCODE-4: плагины — каталог файлов JS/TS (`plugins/`, глобальный и
    // проектный) плюс массив npm-пакетов `plugin` в opencode.json.
    plugins: 'ready',
    // Команды: каталог `commands/*.md` + ключ `command` в конфиге.
    commands: 'ready',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: собственный шлюз OpenCode Zen (models.dev, вендор `opencode`).
  modelVendors: ['opencode'],
};
