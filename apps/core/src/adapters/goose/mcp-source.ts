import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  isRecord,
  readParsed,
  remoteEntry,
  stringMap,
  strings,
  type McpSourceInput,
  type McpSourceRead,
} from '../mcp-source/mcp-source.ts';
import { currentOs, homeDir } from '../../platform/os-kind.ts';
import { roamingAppDataDir } from '../../platform/user-dirs.ts';

/** Каталог конфига Goose человека: `GOOSE_PATH_ROOT/config`, иначе путь ОС. */
export function gooseConfigDir(pin: Record<string, string>): string {
  const root = pin.GOOSE_PATH_ROOT;
  if (root) return join(root, 'config');
  return currentOs() === 'win32'
    ? join(roamingAppDataDir(pin), 'Block', 'goose', 'config')
    : join(homeDir(pin), '.config', 'goose');
}

/**
 * Серверы MCP человека у Goose 1.54: раздел `extensions` его `config.yaml` (каталог —
 * `gooseConfigDir`). Файла проекта с расширениями у Goose нет — только слой пользователя.
 * Сервер MCP — расширение `type: stdio` (`cmd`, `args`, `envs`); `builtin`/`platform`/… — свои
 * расширения Goose, не серверы человека, их нет в предложениях. `enabled: false` — нет сервера.
 * `env_keys` берутся Goose из его хранилища секретов (связка ключей ОС) — ядро их не читает,
 * такой сервер назван, не перенесён без ключей. `streamable_http` (`uri`, `headers` как есть) —
 * удалённый, переносится (s10 p8); `sse` сам Goose 1.54 отвергает — назван.
 */

export function gooseMcpSource(input: McpSourceInput): McpSourceRead {
  const out: McpSourceRead = { servers: [], unread: [] };
  const file = join(gooseConfigDir(input.pin), 'config.yaml');
  const got = readParsed(file, (text) => parseYaml(text) as unknown);
  if ('unread' in got) out.unread.push({ file, reason: got.unread });
  const extensions = 'value' in got && isRecord(got.value) ? got.value.extensions : undefined;
  if (!isRecord(extensions)) return out;
  for (const [id, raw] of Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(raw) || raw.enabled === false) continue;
    const type = raw.type;
    if (type === 'sse') {
      // Строка сборки 1.54: «SSE is unsupported, migrate to streamable_http» — сам Goose не поднял бы.
      out.servers.push({ id, scope: 'user', file, skipped: 'goose 1.54 refuses sse extensions' });
      continue;
    }
    if (type !== 'stdio' && type !== 'streamable_http') continue;
    if (strings(raw.env_keys).length > 0) {
      out.servers.push({
        id,
        scope: 'user',
        file,
        skipped: 'env_keys come from the goose secret store, which the core does not read',
      });
      continue;
    }
    if (type === 'streamable_http') {
      out.servers.push({
        id,
        scope: 'user',
        file,
        ...remoteEntry(raw.uri, 'http', stringMap(raw.headers)),
      });
      continue;
    }
    if (typeof raw.cmd !== 'string' || raw.cmd === '') {
      out.servers.push({ id, scope: 'user', file, skipped: 'no cmd' });
      continue;
    }
    const env = stringMap(raw.envs);
    out.servers.push({
      id,
      scope: 'user',
      file,
      entry: {
        command: raw.cmd,
        args: strings(raw.args),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    });
  }
  return out;
}
