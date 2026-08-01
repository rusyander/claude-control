import type { McpTransport, UniversalMcpTransport } from '@claude-control/contracts';

/**
 * Транспорты MCP-сервера Claude Code — пользовательский уровень и уровень
 * проекта (`.mcp.json`) читают один и тот же список.
 */
export const MCP_TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http'];

/**
 * Переносимый субсет универсальной модели (Gemini/Codex/Cursor/OpenCode): `sse`
 * в него не входит СОЗНАТЕЛЬНО — общего для всех провайдеров формата у него нет.
 */
export const UNIVERSAL_MCP_TRANSPORTS: UniversalMcpTransport[] = ['stdio', 'http'];
