import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { continueHome, unimplementedPaths } from './config-dirs.ts';

/**
 * Continue: `~/.continue/config.yaml` (MCP) + `~/.continue/permissions.yaml` (права).
 *
 * ЧТО ВКЛЮЧЕНО — только подтверждённое документацией:
 *  - **MCP** (`mcp = ready`): ключ `mcpServers` в `config.yaml`. Форма СВОЯ и ни
 *    на кого не похожа — не «имя → запись», а СПИСОК записей с полем `name`
 *    внутри; транспорт задаётся `type` (`stdio` | `sse` | `streamable-http`),
 *    заголовки — в `requestOptions.headers`. Отсюда собственный формат
 *    `continue-yaml` (см. lib/continue-yaml.ts);
 *  - **права** (`permissions = ready`): ОТДЕЛЬНЫЙ файл `permissions.yaml` с тремя
 *    списками `allow` / `ask` / `exclude`. Режима-переключателя у Continue нет —
 *    это пятая модель раздела прав;
 *  - **переменные окружения** (`env = ready`): задокументированный `~/.continue/.env`
 *    (обычный dotenv), из которого берутся секреты `${{ secrets.ИМЯ }}`. Порядок
 *    поиска по документации: `<проект>/.env` → `<проект>/.continue/.env` →
 *    `~/.continue/.env` → окружение процесса; панель ведёт глобальный и проектный
 *    `.continue/.env`;
 *  - **чат** (`chat = ready`): задокументированный headless-режим `cn -p "<промпт>"`;
 *  - **файлы-блоки MCP** (`blockDir`): задокументированный каталог
 *    `.continue/mcpServers/` — каждый `*.yaml` в нём несёт свой список
 *    `mcpServers` под шапкой `name` / `version` / `schema: v1`. Continue грузит
 *    их вместе с `config.yaml`, поэтому раздел показывает и те, и другие, а
 *    правка идёт в тот файл, где запись лежит. Новые серверы панель по-прежнему
 *    кладёт в `config.yaml` — свой файл она не заводит. Каталог блоков есть и в
 *    проекте (`relativeBlockDir`), и глобально: документация описывает его в
 *    рабочей папке, глобальный `~/.continue/mcpServers` Continue сканирует тем
 *    же кодом — это ПОКА НЕ ПРОВЕРЕНО живьём (см. LIMITATIONS-PROVIDERS);
 *  - **проектный уровень** (`projects = ready`): `<проект>/.continue/rules/*.md`
 *    (каталог правил), `<проект>/.continue/mcpServers/mcp.json` (JSON-файл MCP в
 *    задокументированном каталоге блоков — форма `mcpServers` как у Claude
 *    Desktop/Cursor, её Continue подхватывает как есть) и `<проект>/.continue/.env`.
 *
 * ЧЕГО НЕТ: **глобальных инструкций** (`globalInstructions = unsupported`). У
 * Continue задокументирован ТОЛЬКО проектный каталог правил `.continue/rules`;
 * глобального файла инструкций нет, а ключ `rules` в config.yaml — разнородный
 * список (строка правила ИЛИ ссылка `uses:`), под который модели раздела нет.
 * Угадывать не станем.
 */
export const continueProvider: ConfigProvider = {
  id: 'continue',
  name: 'Continue',
  status: 'experimental',
  paths: unimplementedPaths('continue'),
  // Бинарь CLI — `cn` (пакет @continuedev/cli).
  cli: { command: 'cn', windowsCommand: 'cn.cmd' },
  mcpConfig: {
    format: 'continue-yaml',
    path: () => join(continueHome(), 'config.yaml'),
    blockDir: () => join(continueHome(), 'mcpServers'),
  },
  envConfig: { format: 'dotenv', path: () => join(continueHome(), '.env') },
  permissionsConfig: {
    format: 'continue-yaml',
    path: () => join(continueHome(), 'permissions.yaml'),
  },
  projectConfig: {
    instructionsRules: { format: 'continue-md', relativeDir: '.continue/rules' },
    mcp: {
      format: 'json',
      relativePath: '.continue/mcpServers/mcp.json',
      relativeBlockDir: '.continue/mcpServers',
    },
    env: { format: 'dotenv', relativePath: '.continue/.env' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.continue. Только проверка существования.
  configLocations: () => [continueHome()],
  // Ассистент Continue: CLI логинится в аккаунт Continue либо работает по ключу
  // Anthropic; своего единого модельного API у панели тут нет → раннер `cli`.
  // One-shot: `cn -p "<промпт>"` — задокументированный headless-режим.
  assistant: {
    apiKind: 'anthropic',
    apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'CONTINUE_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    // Глобального файла/каталога инструкций у Continue не задокументировано (см.
    // комментарий выше) → раздел скрыт, а не «в разработке».
    globalInstructions: 'unsupported',
    mcp: 'ready',
    permissions: 'ready',
    env: 'ready',
    chat: 'ready',
    // Проектный уровень: каталог правил `.md` + JSON-файл MCP + `.env`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
};
