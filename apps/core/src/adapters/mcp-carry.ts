import type {
  McpRemoteEntry,
  McpServerEntry,
  McpStdioEntry,
  SessionSpec,
} from './adapter.types.ts';

export const isRemoteMcp = (entry: McpServerEntry): entry is McpRemoteEntry =>
  typeof entry.url === 'string';

/** Значения секретов записи (env stdio, заголовки удалённого) — для книги ключей. */
export const mcpSecretValues = (entry: McpServerEntry): Record<string, string> =>
  (isRemoteMcp(entry) ? entry.headers : entry.env) ?? {};

/**
 * Перенос серверов MCP шага в чужой CLI (s10 p6): ровно `spec.mcpServers` — строгий список дороги
 * (мост ядра `agentdeck`, мост панели вопроса, выбранные серверы человека), ничего сверх: дом CLI у
 * сеанса свой. Сервер права (`permitServer`) не переносится — вопрос о праве у этих CLI идёт
 * строкой протокола (ACP `session/request_permission`, запрос app-server), а не инструментом.
 *
 * Окружение сервера (токен сессии моста) и заголовки удалённого уходят CLI в stdin (ACP) или в файл
 * дома сеанса (codex, opencode; каталог 0700, как `mcp.json` у Claude); в журнал — только имена.
 */

export function carriedMcp(spec: SessionSpec): [string, McpServerEntry][] {
  return Object.entries(spec.mcpServers).filter(([name]) => name !== spec.permitServer?.name);
}

/** Какие удалённые транспорты CLI несёт (s10 p8): по опубликованной схеме / ответу `initialize`. */
export interface RemoteSupport {
  http: boolean;
  sse: boolean;
}

export interface CarriedSplit {
  stdio: [string, McpStdioEntry][];
  remote: [string, McpRemoteEntry][];
  /** Серверы, которые CLI не несёт, — строкой потери с причиной (`why`). */
  lost: string[];
}

/** Разделить перенос по транспортам; неподдержанный удалённый — потеря с именем и причиной. */
export function splitCarried(spec: SessionSpec, support: RemoteSupport, why: string): CarriedSplit {
  const split: CarriedSplit = { stdio: [], remote: [], lost: [] };
  for (const [name, entry] of carriedMcp(spec)) {
    if (!isRemoteMcp(entry)) split.stdio.push([name, entry]);
    else if (support[entry.transport]) split.remote.push([name, entry]);
    else split.lost.push(name);
  }
  if (split.lost.length > 0) {
    const transports = [
      ...new Set(
        carriedMcp(spec)
          .filter(([n]) => split.lost.includes(n))
          .map(([, e]) => (isRemoteMcp(e) ? e.transport : 'stdio')),
      ),
    ].join('/');
    split.lost = [
      `remote mcp servers not carried (${transports}: ${why}): ${split.lost.join(', ')}`,
    ];
  }
  return split;
}

/** Сервер MCP в форме ACP `session/new`: stdio без `type`, удалённые — `type` http|sse (схема ACP v1). */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: { name: string; value: string }[] };

const pairs = (record: Record<string, string> | undefined): { name: string; value: string }[] =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

/**
 * Серверы шага для ACP. `support` — что CLI объявил в `agentCapabilities.mcpCapabilities` (запись
 * живого CLI); неподдержанный удалённый в список не идёт — его потерю называет план.
 */
export function acpMcpServers(spec: SessionSpec, support: RemoteSupport): AcpMcpServer[] {
  const split = splitCarried(spec, support, '');
  return [
    ...split.stdio.map(([name, entry]) => ({
      name,
      command: entry.command,
      args: [...entry.args],
      env: pairs(entry.env),
    })),
    ...split.remote.map(([name, entry]) => ({
      type: entry.transport,
      name,
      url: entry.url,
      headers: pairs(entry.headers),
    })),
  ];
}

/**
 * Сверка с `initialize` (s10 p8): CLI, который не объявил транспорт удалённого сервера из списка,
 * отказывает рукопожатию, а не молча теряет сервер. Строка — причина отказа.
 */
export function acpRemoteRefusal(
  servers: readonly AcpMcpServer[],
  agentCapabilities: Record<string, unknown>,
): string | null {
  const declared = agentCapabilities.mcpCapabilities as Record<string, unknown> | undefined;
  const missing = servers.filter((s) => 'type' in s && declared?.[s.type] !== true);
  if (missing.length === 0) return null;
  return `agent does not declare mcpCapabilities for ${missing
    .map((s) => `${s.name} (${'type' in s ? s.type : 'stdio'})`)
    .join(', ')}`;
}
