import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { unimplementedPaths } from './config-dirs.ts';

/** Каталог конфигурации Gemini: переопределения документация не заявляет. */
const geminiHome = (): string => join(homedir(), '.gemini');

/** MCP и права Gemini лежат в одном `settings.json`, каждый — своими ключами. */
const geminiSettings = (): string => join(geminiHome(), 'settings.json');

/** Gemini CLI: GEMINI.md + ~/.gemini/settings.json. */
export const geminiProvider: ConfigProvider = {
  id: 'gemini',
  name: 'Gemini CLI',
  status: 'experimental',
  paths: unimplementedPaths('gemini'),
  cli: { command: 'gemini', windowsCommand: 'gemini.cmd' },
  // Глобальный файл инструкций Gemini задокументирован (~/.gemini/GEMINI.md).
  instructionsFile: () => join(geminiHome(), 'GEMINI.md'),
  // MCP-серверы Gemini — объект mcpServers в ~/.gemini/settings.json. Запись:
  // JSON.parse → правим только ключ mcpServers → JSON.stringify (прочее цело).
  mcpConfig: { format: 'json', path: geminiSettings },
  // Переменные окружения Gemini (GEMINI-3) — задокументированный файл `.env`:
  // глобальный `~/.gemini/.env`, проектный `<проект>/.gemini/.env`. Правка
  // ПОСТРОЧНАЯ: меняются только строки затронутых ключей, комментарии/пустые
  // строки/порядок целы, новые ключи дописываются в конец (см. lib/dotenv-file.ts).
  envConfig: { format: 'dotenv', path: () => join(geminiHome(), '.env') },
  // Права/аппрувы Gemini (GEMINI-2) — в том же settings.json: режим аппрувов
  // `general.defaultApprovalMode` (default | auto_edit | plan) и списки
  // инструментов `coreTools` (белый) / `excludeTools` (чёрный, приоритетнее).
  // Значение `yolo` панель НЕ пишет никогда: по докам это режим только для флага
  // CLI, а в settings.json он валит старт ошибкой enum (сервер отвечает 400).
  permissionsConfig: { format: 'gemini-json', path: geminiSettings },
  // Проектный уровень Gemini (COMMON-2 + GEMINI-2/3): задокументированы проектный
  // GEMINI.md, `<проект>/.gemini/settings.json` (MCP и права — проектные настройки
  // перекрывают пользовательские) и `<проект>/.gemini/.env`. Форматы те же, что у
  // глобальных разделов, — адаптеры переиспользуются целиком.
  projectConfig: {
    instructions: 'GEMINI.md',
    mcp: { format: 'json', relativePath: '.gemini/settings.json' },
    env: { format: 'dotenv', relativePath: '.gemini/.env' },
    permissions: { format: 'gemini-json', relativePath: '.gemini/settings.json' },
  },
  // Слэш-команды Gemini — задокументированный каталог `~/.gemini/commands` с
  // файлами `.toml` (обязателен `prompt`, `description` необязателен), подкаталог
  // даёт пространство имён: `git/fix.toml` вызывается как `/git:fix`. Только чтение.
  commandsConfig: {
    format: 'toml-prompt',
    dir: () => join(geminiHome(), 'commands'),
    namespaceSeparator: ':',
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.gemini. Только проверка существования.
  configLocations: () => [geminiHome()],
  // Ассистент Gemini: API — Google (ключи GEMINI_API_KEY / GOOGLE_API_KEY), есть
  // рабочий CLI (`gemini`). Обе стандартные переменные подхватываются автоматически.
  // One-shot: `gemini -p <prompt>` — неинтерактивный print-режим (флаг задокументирован).
  assistant: {
    apiKind: 'google',
    apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    // GEMINI-2: права — `general.defaultApprovalMode` + coreTools/excludeTools.
    permissions: 'ready',
    // GEMINI-3: переменные окружения — файл `.env` (глобальный и проектный).
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Команды: каталог `commands/*.toml` задокументирован — раздел читает его.
    commands: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Google (models.dev).
  modelVendors: ['google'],
};
