import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { unimplementedPaths } from './config-dirs.ts';

/**
 * Каталог конфигурации Cursor. Переопределения через переменную окружения
 * документация не заявляет → путь всегда от `os.homedir()`.
 */
const cursorHome = (): string => join(homedir(), '.cursor');

/**
 * Cursor: правила-КАТАЛОГ `~/.cursor/rules/*.mdc` + MCP в `~/.cursor/mcp.json`.
 *
 * ИНСТРУКЦИИ У CURSOR — ТРЕТЬЯ МОДЕЛЬ (CURSOR-1). По документации это не один
 * файл (как CLAUDE.md/AGENTS.md/GEMINI.md) и не список ссылок (как `read` у
 * Aider), а КАТАЛОГ файлов `.mdc`: глобальный `~/.cursor/rules/`, проектный
 * `<проект>/.cursor/rules/`, вложенные подкаталоги поддерживаются
 * (`.cursor/rules/frontend/react.mdc`). Каждый файл — YAML-frontmatter с полями
 * `description` (строка), `globs` (шаблоны файлов/каталогов через запятую),
 * `alwaysApply` (булево: подключать в каждый разговор) — и markdown-тело.
 *
 * Обычный `.md` в каталоге правил Cursor ИГНОРИРУЕТ (нет frontmatter) — панель
 * показывает такие файлы отдельным списком и никогда их не правит.
 */
export const cursorProvider: ConfigProvider = {
  id: 'cursor',
  name: 'Cursor',
  status: 'experimental',
  paths: unimplementedPaths('cursor'),
  cli: { command: 'cursor-agent', windowsCommand: 'cursor-agent.cmd' },
  // Правила Cursor — КАТАЛОГ ~/.cursor/rules с файлами `.mdc` (CURSOR-1).
  // `instructionsFile`/`instructionsList` у него не бывает: модель одна из трёх.
  instructionsRules: {
    format: 'cursor-mdc',
    dir: () => join(cursorHome(), 'rules'),
  },
  // MCP-серверы Cursor — глобальный файл ~/.cursor/mcp.json той же формы, что у
  // Claude/Gemini: ключ `mcpServers` → { command, args, env } (stdio) либо { url }
  // (удалённый). Формат json переиспользует общий JSON-адаптер; адрес удалённого
  // сервера у Cursor пишется в `url` (в отличие от gemini-приоритетного httpUrl).
  mcpConfig: {
    format: 'json',
    jsonHttpUrlKey: 'url',
    path: () => join(cursorHome(), 'mcp.json'),
  },
  // Права Cursor (CURSOR-2) — ключ `permissions` файла `~/.cursor/cli-config.json`:
  // ДВА списка правил (`allow` и `deny`, deny приоритетнее), режима-переключателя
  // нет. Файл общий с прочими настройками CLI (`version`, `editor`, …), поэтому
  // правится ТОЛЬКО ключ `permissions`, остальное сохраняется по значениям.
  // Переопределения каталога через переменную окружения документация раздела прав
  // НЕ заявляет → не выдумываем, путь от `os.homedir()` (как у mcp.json и rules).
  permissionsConfig: {
    format: 'cursor-json',
    path: () => join(cursorHome(), 'cli-config.json'),
  },
  // Проектный уровень Cursor (COMMON-2 + CURSOR-1 + CURSOR-2): задокументированы
  // проектный MCP `<проект>/.cursor/mcp.json` (та же форма, адрес удалённого
  // сервера в `url`), проектный КАТАЛОГ ПРАВИЛ `<проект>/.cursor/rules/*.mdc` —
  // тот же формат `.mdc`, что и у глобального каталога, поэтому адаптер
  // переиспользуется целиком, меняется только корень (и он перепроверяется
  // `isInsideProject`), — и проектные ПРАВА `<проект>/.cursor/cli.json`. Имя файла
  // прав в проекте ДРУГОЕ (`cli.json`, не `cli-config.json`), и держит он по
  // документации только права: путь взят из документации дословно.
  projectConfig: {
    instructionsRules: { format: 'cursor-mdc', relativeDir: '.cursor/rules' },
    mcp: { format: 'json', relativePath: '.cursor/mcp.json', jsonHttpUrlKey: 'url' },
    permissions: { format: 'cursor-json', relativePath: '.cursor/cli.json' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.cursor. Только проверка существования.
  configLocations: () => [cursorHome()],
  // У Cursor нет собственного модельного API и запуск ассистента через CLI не
  // поддерживаем → ассистент unsupported (раннер всегда `none`).
  assistant: { apiKind: 'none', apiKeyEnvVars: [], cliRunnable: false },
  capabilities: buildCapabilities({
    // CURSOR-1: правила Cursor — КАТАЛОГ ~/.cursor/rules/*.mdc (много файлов с
    // frontmatter). Формат подтверждён документацией и реализован собственной,
    // ТРЕТЬЕЙ моделью раздела (`instructionsRules`), а не редактором «один файл».
    globalInstructions: 'ready',
    mcp: 'ready',
    // CURSOR-2: права Cursor — ключ `permissions` (`allow`/`deny`) в
    // `cli-config.json`; восьмая модель раздела, без режима и без списка `ask`.
    permissions: 'ready',
    // Проектный уровень (COMMON-2 + CURSOR-1 + CURSOR-2): проектный MCP
    // `.cursor/mcp.json` тем же json-адаптером, проектный каталог правил
    // `.cursor/rules/*.mdc` тем же адаптером `.mdc`, что и глобальный, и
    // проектные права `.cursor/cli.json` тем же адаптером `cursor-json`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
  }),
};
