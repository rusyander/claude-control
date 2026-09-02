import type { McpServerDraft } from '@claude-control/contracts';

interface RawServer {
  command?: string;
  args?: unknown[];
  url?: string;
  type?: string;
  transport?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * Транспорт сервера: без url это всегда stdio, а при url поле type (в некоторых
 * источниках — transport) лишь уточняет sse против http. Адрес без type — http:
 * так же его прочитает сервер панели из ~/.claude.json (`readTransport` в
 * domains/mcp.ts), и так его понимает сам Claude Code. Раньше импорт угадывал
 * здесь sse, и предпросмотр показывал не тот транспорт, что получился бы у той
 * же записи, положенной в файл руками.
 */
function transportOf(raw: RawServer, hasUrl: boolean): McpServerDraft['transport'] {
  if (!hasUrl) return 'stdio';
  if ((raw.type ?? raw.transport) === 'sse') return 'sse';
  return 'http';
}

/**
 * Разбор JSON в список черновиков. Транспорт определяется по наличию url:
 * это надёжнее поля type, которое в разных источниках называется по-разному.
 */
export function parseServers(text: string): { drafts: McpServerDraft[]; error?: string } {
  if (!text.trim()) return { drafts: [] };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { drafts: [], error: 'JSON не разбирается — проверьте синтаксис' };
  }

  const root = json as { mcpServers?: Record<string, RawServer> } & Record<string, RawServer>;
  const servers = root.mcpServers ?? root;

  if (!servers || typeof servers !== 'object') {
    return { drafts: [], error: 'Не нашёл серверов: ожидается объект mcpServers' };
  }

  const drafts: McpServerDraft[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || name === 'mcpServers') continue;

    const hasUrl = typeof raw.url === 'string' && raw.url.length > 0;
    drafts.push({
      name,
      transport: transportOf(raw, hasUrl),
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      url: raw.url,
      env: raw.env ?? {},
      headers: raw.headers ?? {},
      groupIds: [],
    });
  }

  if (drafts.length === 0) return { drafts: [], error: 'В JSON нет ни одного сервера' };
  return { drafts };
}
