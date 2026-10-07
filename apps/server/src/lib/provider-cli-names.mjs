/**
 * Имена CLI провайдеров для процессов, которые не могут импортировать каталог
 * провайдеров (`tools/doctor.mjs` идёт обычным `node`, без разбора TypeScript).
 * Источник правды — `providers/catalog.ts`; совпадение закреплено тестом
 * `provider-cli-names.test.ts`, поэтому новый провайдер без строки здесь краснит.
 */
export const PROVIDER_CLI_NAMES = [
  { id: 'claude', name: 'Claude Code', command: 'claude', windowsCommand: 'claude.cmd' },
  { id: 'codex', name: 'Codex (OpenAI)', command: 'codex', windowsCommand: 'codex.cmd' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', windowsCommand: 'gemini.cmd' },
  { id: 'qwen', name: 'Qwen Code', command: 'qwen', windowsCommand: 'qwen.cmd' },
  { id: 'continue', name: 'Continue', command: 'cn', windowsCommand: 'cn.cmd' },
  { id: 'goose', name: 'Goose', command: 'goose', windowsCommand: 'goose.cmd' },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', windowsCommand: 'kimi.cmd' },
  {
    id: 'cursor',
    name: 'Cursor',
    command: 'cursor-agent',
    windowsCommand: 'cursor-agent.cmd',
  },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', windowsCommand: 'opencode.cmd' },
  { id: 'aider', name: 'Aider', command: 'aider', windowsCommand: 'aider.cmd' },
];
