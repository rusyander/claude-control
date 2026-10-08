import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types/types.ts';
import { gooseConfigDir, unimplementedPaths } from './config-dirs.ts';
import { createGooseStreamParser } from './goose-stream.ts';
import { contourModelName, readConfigRoot } from './run-endpoint.ts';

/** ОДИН `config.yaml` держит и MCP-серверы (`extensions`), и режим `GOOSE_MODE`. */
const gooseConfigYaml = (): string => join(gooseConfigDir(), 'config.yaml');

/**
 * Goose (Block): ОДИН файл `config.yaml` держит и MCP-серверы, и режим аппрувов,
 * а инструкции лежат рядом отдельным файлом `.goosehints`.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *  - каталог: `~/.config/goose` (macOS/Linux), `%APPDATA%\Block\goose\config`
 *    (Windows) — считает `gooseConfigDir()`;
 *  - MCP: ключ `extensions` — ОТОБРАЖЕНИЕ «имя → запись», тип задаёт `type`
 *    (`stdio` / `sse` / `streamable_http` — внешние серверы; `builtin` и прочие —
 *    встроенные расширения Goose, панель их не показывает и не трогает);
 *  - права: скалярный ключ КОРНЯ `GOOSE_MODE` (`auto`, `approve`,
 *    `smart_approve`, `chat`) — модель «один режим», как у Codex, без списков;
 *  - инструкции: `.goosehints` в каталоге конфигурации (глобальные, действуют во
 *    всех сессиях) и `<проект>/.goosehints` (проектные, перекрывают глобальные);
 *  - чат: `goose run --no-session -q --output-format stream-json -t "<промпт>"` —
 *    задокументированный неинтерактивный запуск (`--no-session` не плодит файлы
 *    сессий, поток JSON отделяет ответ от вызовов инструментов — см. `goose-stream.ts`);
 *  - скиллы: папка на скилл со `SKILL.md` (шапка `name` + `description`) — формат
 *    Agent Skills из документации Goose («Agent Skills»). Каталогов Goose читает
 *    несколько: `~/.agents/skills` (рекомендованный, общий с Codex и др.),
 *    `~/.claude/skills`, каталог своей конфигурации и плагины. Раздел панели
 *    ведёт СВОЙ — `<каталог конфигурации>/skills`: его Goose 1.53 читает (снято
 *    `goose skills list`), он идёт за `%APPDATA%` и не публикует скилл всем
 *    CLI сразу; общие каталоги только названы (`alsoLoadedFrom`).
 *
 *  - пофайловые разрешения инструментов: `permission.yaml` рядом с config.yaml —
 *    ТОЛЬКО ПОКАЗ. Три уровня («Always allow» / «Ask before» / «Never allow») в
 *    документации есть, а формата самого файла НЕТ: он известен лишь из
 *    исходников CLI, и правило «чужой формат — только по документации» запрещает
 *    его писать. Панель показывает, что настроено, и отсылает к `goose configure`.
 *
 * ЧЕГО НЕТ: **переменных окружения** (`env = unsupported`). Своего `.env` Goose
 * не загружает: значения берутся из окружения процесса, а секреты — из связки
 * ключей ОС либо `secrets.yaml`, который панель вести не станет.
 */
export const gooseProvider: ConfigProvider = {
  id: 'goose',
  name: 'Goose',
  status: 'experimental',
  paths: unimplementedPaths('goose'),
  cli: { command: 'goose', windowsCommand: 'goose.cmd' },
  instructionsFile: () => join(gooseConfigDir(), '.goosehints'),
  mcpConfig: { format: 'goose-yaml', path: gooseConfigYaml },
  permissionsConfig: {
    format: 'goose-yaml',
    path: gooseConfigYaml,
    // Один скалярный ключ `GOOSE_MODE` на весь CLI: списков правил нет вовсе,
    // поэтому отдельное правило записать НЕКУДА — только режим.
    model: 'mode',
    decisions: [],
    // Пофайловые разрешения инструментов — ТОЛЬКО ПОКАЗ (см. ниже про формат).
    readOnlyToolPermissionsPath: () => join(gooseConfigDir(), 'permission.yaml'),
  },
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(gooseConfigDir(), 'skills'),
    alsoLoadedFrom: () => [
      join(homedir(), '.agents', 'skills'),
      join(homedir(), '.claude', 'skills'),
    ],
  },
  // Проект: подсказки и `.agents/skills` — проектный каталог скиллов из
  // документации Goose (`.goose/skills` и `.claude/skills` он читает лишь ради
  // совместимости). Проектного config.yaml документация не описывает.
  projectConfig: {
    instructions: '.goosehints',
    skills: { format: 'skill-md-dir', relativeDir: '.agents/skills' },
  },
  configLocations: () => [gooseConfigDir()],
  // Своего модельного API у Goose нет: модель даёт провайдер, который настроен
  // внутри самого Goose, а ключ лежит в его связке ключей. Поэтому `none` +
  // запуск через CLI (подписка/настройка пользователя), без ключа в панели.
  assistant: {
    apiKind: 'none',
    apiKeyEnvVars: [],
    cliRunnable: true,
    // Подбора модели (Т12) у Goose НЕТ: `--model` задокументирован только В ПАРЕ
    // с `--provider`, а какой провайдер настроен у пользователя, панель не знает
    // — как и вендора его моделей (`modelVendors` не задан).
    // `-q` снимает заставку, поток JSON — вызовы инструментов: без него и с `-q`
    // Goose 1.53 печатает `▸ shell`, команду и её вывод прямо перед ответом.
    oneShotArgs: (prompt) => [
      'run',
      '--no-session',
      '-q',
      '--output-format',
      'stream-json',
      '-t',
      prompt,
    ],
    parseStdout: createGooseStreamParser,
    // «Разрешить правки» у `run` — режимом `GOOSE_MODE` (флага режима у `run` нет,
    // переменная задокументирована и перекрывает config.yaml — снято живьём).
    // Выкл — `chat`: инструменты пропускаются, ответ приходит. `approve` здесь
    // нельзя: без терминала Goose 1.53 обрывает весь прогон на первом же
    // инструменте («Approve/SmartApprove modes require an interactive terminal»).
    // Вкл — `auto`, иначе тот же обрыв у человека с `approve` в конфиге.
    oneShotEnv: (run) =>
      run?.allowEdits === undefined ? undefined : { GOOSE_MODE: run.allowEdits ? 'auto' : 'chat' },
    // Вход посреди ответа (В1): `goose acp` и его `_goose/unstable/session/steer`.
    liveServer: 'goose-acp',
    // Правки — и живым `goose acp` (режим сессии + `decidePermission`), и одиночным
    // запуском (`GOOSE_MODE`, см. `oneShotEnv`).
    editsControl: 'flag',
  },
  // Контур (X7): провайдер `openai` целиком из окружения — справочник
  // переменных Goose говорит, что окружение перебивает `config.yaml`. Адрес
  // делится на хост и путь (`OPENAI_BASE_PATH` — без ведущей косой черты, с
  // `chat/completions` на конце). Субагенты получают тот же провайдер явно: иначе
  // они пошли бы провайдером из конфига. Заголовок сессии и список моделей
  // идут этим же провайдером — живая проба, всё дошло до заглушки контура.
  runEndpoint: {
    apiKind: 'openai-compat',
    env: ({ baseUrl, model, key }) => {
      const url = new URL(baseUrl);
      const name = contourModelName(model);
      return {
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: name,
        GOOSE_SUBAGENT_PROVIDER: 'openai',
        GOOSE_SUBAGENT_MODEL: name,
        OPENAI_HOST: url.origin,
        OPENAI_BASE_PATH: `${url.pathname.replace(/^\/+|\/+$/g, '')}/chat/completions`,
        OPENAI_API_KEY: key,
      };
    },
    // Ведущая модель другого провайдера (lead/worker) ушла бы своим ключом мимо
    // контура; провайдер `openai` ходит тем же адресом, что и основной.
    bypass: () => {
      const lead = readConfigRoot(gooseConfigYaml(), 'yaml').GOOSE_LEAD_PROVIDER;
      return typeof lead === 'string' && lead.trim() && lead.trim() !== 'openai'
        ? 'GOOSE_LEAD_PROVIDER'
        : undefined;
    },
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    chat: 'ready',
    // Проектный уровень: только `<проект>/.goosehints` — проектного config.yaml
    // документация не описывает, выдумывать его не станем.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Своего `.env` у Goose нет (см. комментарий выше) → раздел скрыт.
    env: 'unsupported',
    skills: 'ready',
    hooks: 'unsupported',
    // Плагины (`goose plugin install <git-url>` / `update <имя>`, каталог
    // `~/.agents/plugins/<имя>/`) задокументированы, но адаптера нет: на Windows
    // Goose 1.53 берёт `~` из профиля ОС, а не из HOME/USERPROFILE (снято: плагин
    // во временном доме он не видит, проектный `.agents/plugins` — видит), так
    // что установку нельзя ни проверить на временном доме, ни отделить от
    // настоящего `~/.agents` человека. Списка и удаления у CLI нет вовсе.
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
};
