import { dirname, join, resolve } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import {
  gitRoot,
  isRecord,
  projectRefusal,
  readParsed,
  remoteEntry,
  stringMap,
  strings,
  type HumanMcpServer,
  type McpSourceInput,
  type McpSourceRead,
} from '../mcp-source/mcp-source.ts';

/**
 * Серверы MCP человека у Kimi Code 2.4.1 (исходник сборки, `resolveMcpJsonPaths` /
 * `loadMcpServersDetailed`, 02.11): три файла формы `{mcpServers:{…}}`, позже — сильнее, запись
 * сервера заменяется ЦЕЛИКОМ (не по полям): `<KIMI_CODE_HOME | ~/.kimi-code>/mcp.json` →
 * `<корень проекта>/.mcp.json` (корень — ближайший `.git`, нет — cwd; `cwd` stdio-сервера по
 * умолчанию — каталог файла, относительный — от него) → `<cwd>/.kimi-code/mcp.json`. Вид сервера:
 * `transport`, иначе `command` → stdio, `url` → http. `enabled: false` — нет сервера. Своего
 * доверия Kimi не ведёт — файлы проекта только при отметке панели (F-86). Сеанс Kimi получает
 * серверы через ACP `session/new`, где каталога запуска нет: сервер с `cwd`, отличным от
 * каталога сеанса, не переносится — назван. Удалённые (`http`/`sse`: `url`, `headers`,
 * `bearerTokenEnvVar` → `Authorization: Bearer` из пина) переносятся (s10 p8, схема сборки
 * `McpServerHttpConfigSchema`); `auth: "oauth"` — токен в хранилище Kimi, назван.
 */

type Layer = { file: string; scope: HumanMcpServer['scope']; cwdBase?: string };

function entryOf(
  raw: Record<string, unknown>,
  layer: Layer,
  sessionCwd: string,
  pin: Record<string, string>,
) {
  const transport =
    typeof raw.transport === 'string'
      ? raw.transport
      : typeof raw.command === 'string'
        ? 'stdio'
        : typeof raw.url === 'string'
          ? 'http'
          : undefined;
  if (transport === 'http' || transport === 'sse') {
    if (raw.auth === 'oauth')
      return { skipped: 'auth oauth lives in the kimi token store: not carried' };
    const headers = stringMap(raw.headers);
    if (typeof raw.bearerTokenEnvVar === 'string') {
      const token = pin[raw.bearerTokenEnvVar];
      if (token === undefined)
        return { skipped: `env var ${raw.bearerTokenEnvVar} unset: kimi would not start it` };
      headers.Authorization = `Bearer ${token}`;
    }
    return remoteEntry(raw.url, transport, headers);
  }
  if (transport !== 'stdio' || typeof raw.command !== 'string' || raw.command === '')
    return { skipped: 'no stdio command' };
  const explicit = typeof raw.cwd === 'string' ? raw.cwd : undefined;
  const cwd =
    explicit !== undefined
      ? layer.cwdBase
        ? resolve(layer.cwdBase, explicit)
        : explicit
      : layer.cwdBase;
  if (cwd !== undefined && resolve(cwd) !== resolve(sessionCwd))
    return { skipped: `server cwd ${cwd} differs from the session cwd: ACP carries no cwd` };
  const env = stringMap(raw.env);
  return {
    entry: {
      command: raw.command,
      args: strings(raw.args),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

export function kimiMcpSource(input: McpSourceInput): McpSourceRead {
  const out: McpSourceRead = { servers: [], unread: [] };
  const layers: Layer[] = [
    {
      file: join(input.pin.KIMI_CODE_HOME || join(homeDir(input.pin), '.kimi-code'), 'mcp.json'),
      scope: 'user',
    },
  ];
  const refusal = projectRefusal(input);
  if (refusal) out.projectSkipped = refusal;
  else {
    const root = gitRoot(input.cwd) ?? resolve(input.cwd);
    const rootFile = join(root, '.mcp.json');
    layers.push({ file: rootFile, scope: 'project', cwdBase: dirname(rootFile) });
    layers.push({ file: join(resolve(input.cwd), '.kimi-code', 'mcp.json'), scope: 'project' });
  }
  const merged = new Map<string, { raw: unknown; layer: Layer }>();
  for (const layer of layers) {
    const got = readParsed(layer.file, (text) => JSON.parse(text) as unknown);
    if ('unread' in got) out.unread.push({ file: layer.file, reason: got.unread });
    const servers = 'value' in got && isRecord(got.value) ? got.value.mcpServers : undefined;
    if (!isRecord(servers)) continue;
    for (const [id, raw] of Object.entries(servers)) merged.set(id, { raw, layer });
  }
  for (const [id, got] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(got.raw) || got.raw.enabled === false) continue;
    out.servers.push({
      id,
      scope: got.layer.scope,
      file: got.layer.file,
      ...entryOf(got.raw, got.layer, input.cwd, input.pin),
    });
  }
  return out;
}
