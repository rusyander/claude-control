import { join } from 'node:path';
import { xdgConfigHome } from '../../platform/user-dirs.ts';
import { stripJsonComments } from '../sdk-stream/repo-deny.ts';
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
 * Серверы MCP человека у opencode (проба 1.18.35, `opencode debug config`, 02.11): ключ `mcp`,
 * слои сливаются вглубь (объекты по ключам, массив `command` — заменой), позже — сильнее:
 * глобальные `<XDG_CONFIG_HOME | ~/.config>/opencode/{config.json, opencode.json, opencode.jsonc}`
 * → файл `OPENCODE_CONFIG` → проект: `opencode.json`, `opencode.jsonc` каждого каталога от корня
 * (`.git`) до cwd, затем `.opencode/opencode.json(c)` так же → `OPENCODE_CONFIG_CONTENT`.
 * Своего доверия у opencode нет — файлы проекта только при отметке панели (F-86).
 * `{env:VAR}` opencode подставляет из своего окружения — здесь из пина задачи (нет — пусто, как
 * у CLI); `{file:…}` не переносится — назван. `type: remote` (`url`, `headers`; схема
 * opencode.ai/config.json `McpRemoteConfig`) переносится (s10 p8); `oauth: {…}` — токены в
 * хранилище opencode, назван.
 */

type Layer = { file: string; scope: HumanMcpServer['scope']; doc: unknown };

const parseJsonc = (text: string): unknown => JSON.parse(stripJsonComments(text));

function substitute(value: string, pin: Record<string, string>): string {
  return value.replace(/\{env:([^}]+)\}/g, (_, name: string) => pin[name.trim()] ?? '');
}

function entryOf(raw: Record<string, unknown>, pin: Record<string, string>) {
  if (raw.type === 'remote') {
    if (isRecord(raw.oauth))
      return { skipped: 'oauth tokens live in the opencode auth store: not carried' };
    const headers = stringMap(raw.headers);
    const url = typeof raw.url === 'string' ? raw.url : '';
    if ([url, ...Object.values(headers)].some((s) => s.includes('{file:')))
      return { skipped: '{file:…} substitution is not carried into a core session' };
    return remoteEntry(
      substitute(url, pin),
      'http',
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, substitute(v, pin)])),
    );
  }
  const command = strings(raw.command);
  if (raw.type !== 'local' || command.length === 0) return { skipped: 'no local command' };
  const env = stringMap(raw.environment);
  if ([...command, ...Object.values(env)].some((s) => s.includes('{file:')))
    return { skipped: '{file:…} substitution is not carried into a core session' };
  const [cmd, ...args] = command.map((s) => substitute(s, pin));
  const environment = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, substitute(value, pin)]),
  );
  return {
    entry: {
      command: cmd!,
      args,
      ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
    },
  };
}

export function opencodeMcpSource(input: McpSourceInput): McpSourceRead {
  const out: McpSourceRead = { servers: [], unread: [] };
  const layers: Layer[] = [];
  const add = (file: string, scope: Layer['scope']) => {
    const got = readParsed(file, parseJsonc);
    if ('unread' in got) out.unread.push({ file, reason: got.unread });
    if ('value' in got) layers.push({ file, scope, doc: got.value });
  };
  const global = join(xdgConfigHome(input.pin), 'opencode');
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc'])
    add(join(global, name), 'user');
  if (input.pin.OPENCODE_CONFIG) add(input.pin.OPENCODE_CONFIG, 'user');

  const refusal = projectRefusal(input);
  if (refusal) out.projectSkipped = refusal;
  else {
    const dirs = rootToCwd(input.cwd);
    for (const dir of dirs)
      for (const name of ['opencode.json', 'opencode.jsonc']) add(join(dir, name), 'project');
    for (const dir of dirs)
      for (const name of ['opencode.json', 'opencode.jsonc'])
        add(join(dir, '.opencode', name), 'project');
  }
  if (input.pin.OPENCODE_CONFIG_CONTENT) {
    try {
      layers.push({
        file: 'OPENCODE_CONFIG_CONTENT',
        scope: 'user',
        doc: parseJsonc(input.pin.OPENCODE_CONFIG_CONTENT),
      });
    } catch (error) {
      out.unread.push({ file: 'OPENCODE_CONFIG_CONTENT', reason: `unparseable: ${String(error)}` });
    }
  }

  const merged = new Map<string, { raw: unknown; file: string; scope: Layer['scope'] }>();
  for (const layer of layers) {
    const mcp = isRecord(layer.doc) ? layer.doc.mcp : undefined;
    if (!isRecord(mcp)) continue;
    for (const [id, raw] of Object.entries(mcp)) {
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
