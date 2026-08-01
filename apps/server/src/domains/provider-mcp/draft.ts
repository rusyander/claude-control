import type { UniversalMcpServerDraft } from '@claude-control/contracts';
import { isStringRecord, stringList } from './values.ts';

// --- Общий разбор черновика (валидация на стороне сервера) -------------------

/**
 * Разобрать и проверить черновик из тела запроса. Схему contracts (zod) в рантайме
 * сервера использовать нельзя (значение из contracts роняет node ESM), поэтому
 * проверяем руками. Некорректный черновик → `undefined` (маршрут ответит 400).
 */
export function parseUniversalDraft(body: unknown): UniversalMcpServerDraft | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return undefined;

  const transport = b.transport === 'http' ? 'http' : b.transport === 'stdio' ? 'stdio' : undefined;
  if (!transport) return undefined;

  const command = typeof b.command === 'string' ? b.command.trim() : undefined;
  const url = typeof b.url === 'string' ? b.url.trim() : undefined;
  if (transport === 'stdio' && !command) return undefined;
  if (transport === 'http' && !url) return undefined;

  const args = stringList(b.args);
  const env = isStringRecord(b.env) ? b.env : {};
  const headers = isStringRecord(b.headers) ? b.headers : {};

  return { name, transport, command, args, env, url, headers };
}

/** Имя MCP-сервера уже занято — маршрут отвечает 409, а не пишет поверх чужой записи. */
export class McpServerExistsError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`MCP-сервер «${serverName}» уже есть в конфигурации.`);
    this.name = 'McpServerExistsError';
    this.serverName = serverName;
  }
}
