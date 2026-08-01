import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { codexHome, unimplementedPaths } from './config-dirs.ts';

/**
 * Один и тот же `~/.codex/config.toml` держит сразу три раздела — MCP,
 * переменные окружения и права; каждый правится хирургически, своим регионом.
 */
const codexConfigToml = (): string => join(codexHome(), 'config.toml');

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
  // Права/аппрувы Codex — скалярные ключи КОРНЯ config.toml (`approval_policy` /
  // `sandbox_mode`). Запись хирургическая (upsertCodexRootScalar): правится только
  // сам корневой скаляр, одноимённые ключи внутри таблиц (`[profiles.x]`) не тронуты.
  permissionsConfig: { format: 'toml', path: codexConfigToml },
  // Проектный уровень Codex (COMMON-2): задокументированы проектный AGENTS.md в
  // корне и проектный `.codex/config.toml` (приоритет проект > профиль > глобаль).
  // Файл тот же формат TOML, что и глобальный, — адаптер переиспользуется целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'toml', relativePath: '.codex/config.toml' },
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.codex. Только проверка существования.
  configLocations: () => [codexHome()],
  // Ассистент Codex: API — OpenAI (ключ OPENAI_API_KEY), есть рабочий CLI (`codex`).
  // One-shot: `codex exec <prompt>` — неинтерактивный запуск (флаг задокументирован).
  assistant: {
    apiKind: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['exec', prompt],
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
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог OpenAI (models.dev). Codex CLI работает с моделями OpenAI.
  modelVendors: ['openai'],
};
