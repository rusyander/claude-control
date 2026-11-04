import { join, resolve } from 'node:path';
import { samePath } from '../../platform/paths.ts';
import type { McpServerEntry } from '../adapter.types.ts';
import {
  expandVars,
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
import { claudeGlobalConfigFiles } from './trust.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Серверы MCP человека у Claude Code 2.1.310 (s10 p8, паритет старого чата панели: тот шёл без
 * `--strict-mcp-config`, и CLI поднимал всё своё). Порядок самого CLI, позже — сильнее, запись
 * заменяется целиком:
 * - `user` — `mcpServers` глобального конфига (`<CLAUDE_CONFIG_DIR | дом>/.claude.json`; старый
 *   `.config.json` каталога конфигурации — первым, если не пуст, как у доверия);
 * - `project` — `<cwd>/.mcp.json`, только при доверии к исходному репозиторию (отметка панели или
 *   `hasTrustDialogAccepted`) И одобрении сервера: `enableAllProjectMcpServers` или
 *   `enabledMcpjsonServers`, минус `disabledMcpjsonServers` (запись проекта в глобальном конфиге,
 *   личный `settings.json`, `.claude/settings{,.local}.json` проекта; отказ сильнее);
 * - `local` (здесь `user`: файл человека) — `projects[<исходный репозиторий>].mcpServers`.
 * Выключенные `/mcp` (`projects[…].disabledMcpServers`) — нет сервера. `${VAR}`/`${VAR:-x}` — из
 * пина; переменной нет — сервер назван. `ws`, `headersHelper` и серверы плагинов/claude.ai не
 * переносятся — названы (первые два) или не видны (последние: живут вне этих файлов).
 */

type Raw = Record<string, unknown>;
interface Approval {
  enableAllProjectMcpServers?: unknown;
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
}

function expandAll(
  record: Record<string, string>,
  pin: Record<string, string>,
): { value: Record<string, string> } | { missing: string } {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(record)) {
    const got = expandVars(text, pin);
    if ('missing' in got) return got;
    out[key] = got.value;
  }
  return { value: out };
}

/** Запись Claude → запуск ядра; не переносится — причина. */
export function claudeEntryOf(
  raw: Raw,
  pin: Record<string, string>,
): { entry: McpServerEntry } | { skipped: string } {
  const type = typeof raw.type === 'string' ? raw.type : 'stdio';
  const missing = (name: string) => ({
    skipped: `env var ${name} unset: claude would not start it`,
  });
  if (type === 'http' || type === 'sse') {
    if (raw.headersHelper !== undefined)
      return { skipped: 'headersHelper is a command run by the CLI: not carried' };
    const url = typeof raw.url === 'string' ? expandVars(raw.url, pin) : null;
    if (url && 'missing' in url) return missing(url.missing);
    const headers = expandAll(stringMap(raw.headers), pin);
    if ('missing' in headers) return missing(headers.missing);
    return remoteEntry(url?.value, type, headers.value);
  }
  if (type !== 'stdio') return { skipped: `transport ${type} is not carried into a core session` };
  if (typeof raw.command !== 'string' || raw.command === '') return { skipped: 'no stdio command' };
  const parts = expandAll(
    Object.fromEntries([raw.command, ...strings(raw.args)].map((v, i) => [String(i), v])),
    pin,
  );
  if ('missing' in parts) return missing(parts.missing);
  const env = expandAll(stringMap(raw.env), pin);
  if ('missing' in env) return missing(env.missing);
  const [command, ...args] = Object.values(parts.value) as [string, ...string[]];
  return {
    entry: { command, args, ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}) },
  };
}

const servers = (doc: unknown): Record<string, unknown> =>
  isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : {};

export function claudeMcpSource(input: McpSourceInput): McpSourceRead {
  const out: McpSourceRead = { servers: [], unread: [] };
  const files = claudeGlobalConfigFiles(input.pin);
  const legacy = readParsed(files.legacy, (text) => JSON.parse(text) as unknown);
  const globalFile = 'value' in legacy ? files.legacy : files.main;
  const global =
    'value' in legacy ? legacy : readParsed(globalFile, (t) => JSON.parse(t) as unknown);
  if ('unread' in legacy) out.unread.push({ file: files.legacy, reason: legacy.unread });
  if ('unread' in global && globalFile === files.main)
    out.unread.push({ file: globalFile, reason: global.unread });
  const doc = 'value' in global ? global.value : {};
  const repo = input.trust?.sourceRepo ?? resolve(input.cwd);
  const projects = isRecord(doc) && isRecord(doc.projects) ? doc.projects : {};
  const own = Object.entries(projects)
    .filter(([path, entry]) => isRecord(entry) && samePath(path, repo))
    .map(([, entry]) => entry as Raw);

  const merged = new Map<string, { raw: unknown; scope: HumanMcpServer['scope']; file: string }>();
  for (const [id, raw] of Object.entries(servers(doc)))
    merged.set(id, { raw, scope: 'user', file: globalFile });

  const trusted = (sourceRepo: string): boolean =>
    Object.entries(projects).some(
      ([path, entry]) =>
        isRecord(entry) && entry.hasTrustDialogAccepted === true && samePath(path, sourceRepo),
    );
  const refusal = projectRefusal(input, trusted);
  if (refusal) out.projectSkipped = refusal;
  else {
    const projectFile = join(resolve(input.cwd), '.mcp.json');
    const got = readParsed(projectFile, (text) => JSON.parse(text) as unknown);
    if ('unread' in got) out.unread.push({ file: projectFile, reason: got.unread });
    const approvals: Approval[] = [
      ...own,
      ...[
        join(claudeConfigDir(input.pin), 'settings.json'),
        join(resolve(input.cwd), '.claude', 'settings.json'),
        join(resolve(input.cwd), '.claude', 'settings.local.json'),
      ].map((file) => {
        const read = readParsed(file, (text) => JSON.parse(text) as unknown);
        return 'value' in read && isRecord(read.value) ? (read.value as Approval) : {};
      }),
    ];
    const all = approvals.some((a) => a.enableAllProjectMcpServers === true);
    const enabled = new Set(approvals.flatMap((a) => strings(a.enabledMcpjsonServers)));
    const disabled = new Set(approvals.flatMap((a) => strings(a.disabledMcpjsonServers)));
    for (const [id, raw] of Object.entries(servers('value' in got ? got.value : {}))) {
      // Неодобренная запись проекта отсеивается ДО слияния: личная с тем же именем остаётся.
      if (disabled.has(id) || !(all || enabled.has(id))) continue;
      merged.set(id, { raw, scope: 'project', file: projectFile });
    }
  }
  for (const entry of own)
    for (const [id, raw] of Object.entries(servers(entry)))
      merged.set(id, { raw, scope: 'user', file: globalFile });

  const off = new Set(own.flatMap((entry) => strings(entry.disabledMcpServers)));
  for (const [id, got] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    if (off.has(id) || !isRecord(got.raw)) continue;
    out.servers.push({
      id,
      scope: got.scope,
      file: got.file,
      ...claudeEntryOf(got.raw, input.pin),
    });
  }
  return out;
}
