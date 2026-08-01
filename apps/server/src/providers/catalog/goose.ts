import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { gooseConfigDir, unimplementedPaths } from './config-dirs.ts';

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
 *  - чат: `goose run --no-session -t "<промпт>"` — задокументированный
 *    неинтерактивный запуск (`--no-session` не плодит файлы сессий).
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
    // Пофайловые разрешения инструментов — ТОЛЬКО ПОКАЗ (см. ниже про формат).
    readOnlyToolPermissionsPath: () => join(gooseConfigDir(), 'permission.yaml'),
  },
  projectConfig: { instructions: '.goosehints' },
  configLocations: () => [gooseConfigDir()],
  // Своего модельного API у Goose нет: модель даёт провайдер, который настроен
  // внутри самого Goose, а ключ лежит в его связке ключей. Поэтому `none` +
  // запуск через CLI (подписка/настройка пользователя), без ключа в панели.
  assistant: {
    apiKind: 'none',
    apiKeyEnvVars: [],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['run', '--no-session', '-t', prompt],
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
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
};
