import { detectClaudeLocation } from '../lib/claude-paths.ts';
import { uniformCapabilities, type ConfigProvider } from './types.ts';

/**
 * Адаптер Claude Code — провайдер #1. Поведение панели не меняется: пути
 * делегируются существующему `lib/claude-paths.ts`, а не дублируются, CLI —
 * `claude` (на Windows `claude.cmd`). Статус `verified`, а все возможности —
 * `ready`: у Claude каждый раздел панели реально работает.
 */
export const claudeProvider: ConfigProvider = {
  id: 'claude',
  name: 'Claude Code',
  status: 'verified',
  paths: (override) => detectClaudeLocation(override).paths,
  cli: { command: 'claude', windowsCommand: 'claude.cmd' },
  capabilities: uniformCapabilities('ready'),
  // Файл инструкций — тот же CLAUDE.md, что и раздел «Правила»; уважает
  // пользовательский каталог (override/env), поэтому делегируем детекту, а не
  // хардкодим ~/.claude. Поведение раздела не меняется (регресс-ноль).
  instructionsFile: (override) => detectClaudeLocation(override).paths.claudeMd,
  // Детект «конфиг найден» (Ф7): корень каталога конфигурации Claude. Уважает
  // пользовательский путь (override/env) — как и остальные разделы, поэтому идём
  // через тот же детект расположения, а не через хардкод ~/.claude.
  configLocations: (override) => [detectClaudeLocation(override).paths.root],
  // Ассистент Claude: API — Anthropic (ключ ANTHROPIC_API_KEY), но у него есть
  // рабочий CLI-путь (`claude`), поэтому при отсутствии ключа, но найденном CLI
  // раннер = `cli` — текущее поведение чата сохраняется (регресс-ноль).
  assistant: { apiKind: 'anthropic', apiKeyEnvVars: ['ANTHROPIC_API_KEY'], cliRunnable: true },
  // Модели: каталог Anthropic (models.dev). Алиасы (`opus`, `sonnet`, `haiku`)
  // CLI разворачивает сам, поэтому каталог нужен ровно для двух вещей — видеть
  // вышедшие модели и заметить смену поколения у пришпиленного дефолта.
  modelVendors: ['anthropic'],
};
