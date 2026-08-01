import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { OPENCODE_MODELLED_KEYS } from './constants.ts';
import { backupNameOf } from './target.ts';
import type { ProviderMcpTarget } from './types.ts';
import { isStringRecord, preserveUnmodelled, sortByName, stringList } from './values.ts';

// --- Формат `opencode-json`: ключ mcp в ~/.config/opencode/opencode.json -----

type RawOpencodeServer = Record<string, unknown>;

interface RawOpencodeConfig {
  mcp?: Record<string, RawOpencodeServer>;
  [key: string]: unknown;
}

export function readOpencodeServers(text: string): UniversalMcpServer[] {
  const servers = parseProviderJsonObject<RawOpencodeConfig>(text).mcp ?? {};
  return sortByName(
    Object.entries(servers).map(([name, raw]): UniversalMcpServer => {
      const url = typeof raw.url === 'string' ? raw.url : undefined;
      // Транспорт определяется полем type; если оно нестандартное — опираемся на
      // наличие url (чтение неразрушающее, писать наугад мы всё равно не будем).
      const isRemote = raw.type === 'remote' || (raw.type !== 'local' && url !== undefined);
      // `command` у opencode — МАССИВ: [команда, ...аргументы].
      const commandLine = stringList(raw.command);
      return {
        name,
        transport: isRemote ? 'http' : 'stdio',
        command: commandLine[0],
        args: commandLine.slice(1),
        env: isStringRecord(raw.environment) ? raw.environment : {},
        url: isRemote ? url : undefined,
        headers: isStringRecord(raw.headers) ? raw.headers : {},
      };
    }),
  );
}

/**
 * Собрать запись сервера opencode из черновика, СОХРАНИВ немоделируемые поля
 * прежней записи (`enabled` и любые неизвестные ключи).
 */
function buildOpencodeRaw(
  draft: UniversalMcpServerDraft,
  existing: RawOpencodeServer | undefined,
): RawOpencodeServer {
  const preserved = preserveUnmodelled(existing, OPENCODE_MODELLED_KEYS);

  const raw: RawOpencodeServer = {};
  if (draft.transport === 'stdio') {
    raw.type = 'local';
    // command — массив: первый элемент команда, остальные аргументы.
    if (draft.command) raw.command = [draft.command, ...draft.args];
    if (Object.keys(draft.env).length > 0) raw.environment = draft.env;
  } else {
    raw.type = 'remote';
    if (draft.url) raw.url = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.headers = draft.headers;
  }
  return { ...raw, ...preserved };
}

/**
 * Записать opencode.json, поменяв ТОЛЬКО одну запись в ключе `mcp`. Прочие ключи
 * файла (`$schema`, model, agents, …) и прочие серверы сохраняются как есть.
 */
function writeOpencodeConfig(
  target: ProviderMcpTarget,
  mutate: (config: RawOpencodeConfig) => void,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  config.mcp ??= {};
  mutate(config);
  return writeTextFile(target.filePath, `${JSON.stringify(config, null, 2)}\n`, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

export function upsertOpencodeServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  return writeOpencodeConfig(
    target,
    (config) => {
      const servers = config.mcp!;
      // При переименовании немоделируемые поля переносим со СТАРОГО имени.
      const existing = (serverId ? servers[serverId] : undefined) ?? servers[draft.name];
      if (serverId && serverId !== draft.name) delete servers[serverId];
      servers[draft.name] = buildOpencodeRaw(draft, existing);
    },
    backupDir,
  );
}

export function deleteOpencodeServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  return writeOpencodeConfig(
    target,
    (config) => {
      delete config.mcp![serverId];
    },
    backupDir,
  );
}
