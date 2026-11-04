import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { homeDir } from '../../platform/os-kind.ts';
import { pathsFoldCase } from '../../platform/user-dirs.ts';
import type { McpServerEntry } from '../adapter.types.ts';
import {
  deepMerge,
  isRecord,
  projectRefusal,
  readParsed,
  remoteEntry,
  rootToCwd,
  stringMap,
  strings,
  type HumanMcpServer,
  type McpSourceInput,
  type McpSourceRead,
} from '../mcp-source/mcp-source.ts';

/**
 * Серверы MCP человека у Codex (проба 0.155.1, `codex mcp list`, 02.11): таблицы
 * `[mcp_servers.<имя>]` в `<CODEX_HOME | ~/.codex>/config.toml`, затем `.codex/config.toml`
 * каждого каталога от корня проекта (`.git`) до cwd — только у доверенного проекта (запись
 * `[projects.'<путь>'] trust_level = "trusted"` в конфиге пользователя, ключ — путь Windows с `\`,
 * регистр не важен). Слои сливаются ПО ПОЛЯМ: проект меняет `command`, `args`/`env` пользователя
 * остаются; ближний к cwd слой сильнее. `enabled = false` — сервера нет. `env_vars` — имена,
 * которые Codex переносит из своего окружения: здесь значения берутся из пина задачи.
 * Удалённый сервер (`url`, streamable http — форма docs/config.md, s10 p8): `http_headers` как
 * есть, `env_http_headers` (заголовок → имя переменной) и `bearer_token_env_var` (→ `Authorization:
 * Bearer`) — значения из пина; переменной нет — Codex сервер не поднял бы, назван.
 */

type Layer = { file: string; scope: HumanMcpServer['scope']; doc: Record<string, unknown> };

function userConfigFile(pin: Record<string, string>): string {
  return join(pin.CODEX_HOME || join(homeDir(pin), '.codex'), 'config.toml');
}

function trustedBy(userDoc: Record<string, unknown> | undefined) {
  return (sourceRepo: string): boolean => {
    const projects = userDoc?.projects;
    if (!isRecord(projects)) return false;
    const want = resolve(sourceRepo);
    const fold = pathsFoldCase();
    const same = (key: string) => (fold ? key.toLowerCase() === want.toLowerCase() : key === want);
    return Object.entries(projects).some(
      ([key, row]) =>
        same(key.replace(/[\\/]+$/, '')) && isRecord(row) && row.trust_level === 'trusted',
    );
  };
}

function remoteOf(raw: Record<string, unknown>, pin: Record<string, string>) {
  const unset = (name: string) => ({ skipped: `env var ${name} unset: codex would not start it` });
  const headers = stringMap(raw.http_headers);
  for (const [header, name] of Object.entries(stringMap(raw.env_http_headers))) {
    const value = pin[name];
    if (value === undefined) return unset(name);
    headers[header] = value;
  }
  if (typeof raw.bearer_token_env_var === 'string') {
    const token = pin[raw.bearer_token_env_var];
    if (token === undefined) return unset(raw.bearer_token_env_var);
    headers.Authorization = `Bearer ${token}`;
  }
  return remoteEntry(raw.url, 'http', headers);
}

function entryOf(raw: Record<string, unknown>, pin: Record<string, string>) {
  if (typeof raw.url === 'string') return remoteOf(raw, pin);
  if (typeof raw.command !== 'string' || raw.command === '') return { skipped: 'no command' };
  const env = stringMap(raw.env);
  for (const name of strings(raw.env_vars)) {
    const value = pin[name];
    if (value !== undefined && !(name in env)) env[name] = value;
  }
  const entry: McpServerEntry = {
    command: raw.command,
    args: strings(raw.args),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof raw.cwd === 'string' && raw.cwd !== '' ? { cwd: raw.cwd } : {}),
  };
  return { entry };
}

export function codexMcpSource(input: McpSourceInput): McpSourceRead {
  const out: McpSourceRead = { servers: [], unread: [] };
  const layers: Layer[] = [];
  const userFile = userConfigFile(input.pin);
  const user = readParsed(userFile, parseToml);
  if ('unread' in user) out.unread.push({ file: userFile, reason: user.unread });
  const userDoc = 'value' in user ? (user.value as Record<string, unknown>) : undefined;
  if (userDoc) layers.push({ file: userFile, scope: 'user', doc: userDoc });

  const refusal = projectRefusal(input, trustedBy(userDoc));
  if (refusal) out.projectSkipped = refusal;
  else
    for (const dir of rootToCwd(input.cwd)) {
      const file = join(dir, '.codex', 'config.toml');
      const got = readParsed(file, parseToml);
      if ('unread' in got) out.unread.push({ file, reason: got.unread });
      if ('value' in got)
        layers.push({ file, scope: 'project', doc: got.value as Record<string, unknown> });
    }

  const merged = new Map<string, { raw: unknown; file: string; scope: Layer['scope'] }>();
  for (const layer of layers) {
    const servers = layer.doc.mcp_servers;
    if (!isRecord(servers)) continue;
    for (const [id, raw] of Object.entries(servers)) {
      const was = merged.get(id);
      merged.set(id, { raw: deepMerge(was?.raw, raw), file: layer.file, scope: layer.scope });
    }
  }
  for (const [id, got] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(got.raw) || got.raw.enabled === false) continue;
    out.servers.push({ id, scope: got.scope, file: got.file, ...entryOf(got.raw, input.pin) });
  }
  return out;
}
