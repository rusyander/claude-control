import { existsSync, readFileSync } from 'node:fs';
import { stringify as stringifyToml } from 'smol-toml';
import type { UniversalMcpServer, UniversalMcpServerDraft } from '@claude-control/contracts';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  spliceCodexTableRegion,
  stableToml,
} from '../../lib/codex-toml.ts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { CODEX_MODELLED_KEYS } from './constants.ts';
import { backupNameOf } from './target.ts';
import type { ProviderMcpTarget } from './types.ts';
import { isStringRecord, preserveUnmodelled, sortByName, stringList } from './values.ts';

// --- Codex (TOML: ~/.codex/config.toml, таблицы [mcp_servers.<name>]) --------

type RawCodexServer = Record<string, unknown>;

/** Разобрать config.toml. Невалидный TOML → fail-closed (read-only). */
function parseCodexRaw(text: string): Record<string, RawCodexServer> {
  const parsed = parseCodexToml(text);
  const servers = parsed.mcp_servers;
  if (servers === undefined) return {};
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new UnrecognizedFormatError();
  }
  return servers as Record<string, RawCodexServer>;
}

export function readCodexServers(text: string): UniversalMcpServer[] {
  return sortByName(
    Object.entries(parseCodexRaw(text)).map(([name, entry]): UniversalMcpServer => {
      const url = typeof entry.url === 'string' ? entry.url : undefined;
      const transport = url ? 'http' : 'stdio';
      return {
        name,
        transport,
        command: typeof entry.command === 'string' ? entry.command : undefined,
        args: stringList(entry.args),
        env: isStringRecord(entry.env) ? entry.env : {},
        url,
        // codex хранит заголовки http под http_headers.
        headers: isStringRecord(entry.http_headers) ? entry.http_headers : {},
      };
    }),
  );
}

/** Собрать запись сервера codex из черновика, сохранив чужие поля прежней. */
function buildCodexRaw(draft: UniversalMcpServerDraft, existing?: RawCodexServer): RawCodexServer {
  const raw: RawCodexServer = preserveUnmodelled(existing, CODEX_MODELLED_KEYS);
  if (draft.transport === 'stdio') {
    if (draft.command) raw.command = draft.command;
    if (draft.args.length > 0) raw.args = draft.args;
    if (Object.keys(draft.env).length > 0) raw.env = draft.env;
  } else {
    // codex: untagged-транспорт определяется наличием url (без ключа transport);
    // для http env запрещён, заголовки идут в http_headers.
    if (draft.url) raw.url = draft.url;
    if (Object.keys(draft.headers).length > 0) raw.http_headers = draft.headers;
  }
  return raw;
}

/**
 * Записать config.toml с новым набором серверов. Хирургически заменяет регион
 * mcp_servers; чужие поля существующих серверов сохраняются (проходят через
 * разобранные raw-записи). После сборки итог репарсится и сверяется с намерением
 * — расхождение → fail-closed (не пишем).
 */
function writeCodexServers(
  target: ProviderMcpTarget,
  raw: Record<string, RawCodexServer>,
  backupDir: string | undefined,
): string | undefined {
  const exists = existsSync(target.filePath);
  const original = exists ? readFileSync(target.filePath, 'utf8') : '';

  // Оригинал обязан парситься — иначе не знаем, где регион (fail-closed).
  if (original.trim()) parseCodexToml(original);

  const hasServers = Object.keys(raw).length > 0;
  const block = hasServers ? stringifyToml({ mcp_servers: raw }) : '';

  let next: string;
  if (!original.trim()) {
    next = hasServers ? `${block.replace(/\n+$/, '')}\n` : '';
  } else {
    next = spliceCodexTableRegion(original, block, 'mcp_servers');
  }

  // Верификация: итог обязан валидно репарситься, а его mcp_servers — точно
  // совпадать с намерением. Иначе surgery что-то испортила → не пишем.
  if (next.trim()) {
    const reparsed = parseCodexToml(next);
    const got = reparsed.mcp_servers ?? {};
    if (stableToml(got) !== stableToml(raw)) throw new UnrecognizedFormatError();
  } else if (hasServers) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm:false — итог собран ИЗ ИСХОДНОГО текста (всё вне региона
  // байт-в-байт, BOM исходника на месте, стиль переводов строк учтён в splice).
  // Общая нормализация здесь как раз нарушила бы байт-в-байт на файле со
  // смешанными окончаниями строк.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    preserveForm: false,
  });
}

/** Сырые записи mcp_servers текущего файла — основа правки (чужие поля целы). */
function currentCodexRaw(target: ProviderMcpTarget): Record<string, RawCodexServer> {
  const text = readTextFile(target.filePath);
  return text.trim() ? parseCodexRaw(text) : {};
}

export function upsertCodexServer(
  target: ProviderMcpTarget,
  serverId: string | null,
  draft: UniversalMcpServerDraft,
  backupDir: string | undefined,
): string | undefined {
  const raw = currentCodexRaw(target);
  // При переименовании немоделируемые поля переносим со СТАРОГО имени.
  const existing = (serverId ? raw[serverId] : undefined) ?? raw[draft.name];
  if (serverId && serverId !== draft.name) delete raw[serverId];
  raw[draft.name] = buildCodexRaw(draft, existing);
  return writeCodexServers(target, raw, backupDir);
}

export function deleteCodexServer(
  target: ProviderMcpTarget,
  serverId: string,
  backupDir: string | undefined,
): string | undefined {
  const raw = currentCodexRaw(target);
  delete raw[serverId];
  return writeCodexServers(target, raw, backupDir);
}
