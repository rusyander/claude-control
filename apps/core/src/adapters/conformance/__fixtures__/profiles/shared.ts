/** Адрес, который профили отдают переходнику: порт 9 (discard) — подставной CLI туда не ходит. */
export const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };

/** Имена серверов MCP, присланные клиентом в ACP `session/new` / `session/load` (дамп подставного CLI). */
export function acpMcpNames(stdin: readonly Record<string, unknown>[]): string[] {
  const start = stdin.find((m) => m.method === 'session/new' || m.method === 'session/load');
  const params = start?.params as { mcpServers?: { name: string }[] } | undefined;
  return (params?.mcpServers ?? []).map((s) => s.name);
}

/** Значение флага в argv (`--flag value`). */
export const after = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];
