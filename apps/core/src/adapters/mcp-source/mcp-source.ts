import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { McpRemoteEntry, McpSourceInput, McpSourceRead } from '../adapter.types.ts';

export type { HumanMcpServer, McpSourceInput, McpSourceRead } from '../adapter.types.ts';

/**
 * Общее у читателей MCP человека (P73, s10 p7): каждый CLI читает свои файлы в своём порядке
 * (`adapters/<cli>/mcp-source.ts`), здесь — только поиск корня проекта, суд доверия и разбор
 * файла с названной причиной. Значения `env` серверов в журнал не идут: читатель отдаёт их дороге,
 * дорога — переходнику (файл дома сеанса 0700 или stdin ACP), в журнале — только имена.
 */

/** Корень проекта, как его ищут CLI: ближайший предок `cwd` с `.git`; нет — `null`. */
export function gitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Каталоги от корня проекта (или самого `cwd`, если корня нет) вниз до `cwd` включительно. */
export function rootToCwd(cwd: string): string[] {
  const end = resolve(cwd);
  const root = gitRoot(end) ?? end;
  const out = [end];
  let dir = end;
  while (dir !== root) {
    const up = dirname(dir);
    if (up === dir) break;
    out.unshift(up);
    dir = up;
  }
  return out;
}

/**
 * Можно ли читать файлы проекта: отметка панели или запись доверия самого CLI к ИСХОДНОМУ
 * репозиторию (F-86). Возвращает причину отказа; доверие есть — `null`.
 */
export function projectRefusal(
  input: McpSourceInput,
  cliTrusts?: (sourceRepo: string) => boolean,
): string | null {
  const trust = input.trust;
  if (!trust) return 'no source repository trust: project MCP files not read';
  if (trust.panelMark) return null;
  if (cliTrusts?.(trust.sourceRepo)) return null;
  return `source repository ${trust.sourceRepo} not trusted: project MCP files not read`;
}

export type FileRead<T> = { absent: true } | { value: T } | { unread: string };

/** Прочитать и разобрать файл; нет файла — `absent`, не разобран — причина. */
export function readParsed<T>(file: string, parse: (text: string) => T): FileRead<T> {
  let text = '';
  let failure: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    failure = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  // «Нет файла» решается по коду ошибки вне catch (P44): прочий сбой — причина, не «нет».
  if (failure !== undefined && failure !== 'ENOENT' && failure !== 'ENOTDIR') {
    return { unread: `unreadable: ${failure}` };
  }
  if (failure !== undefined || text.trim() === '') return { absent: true };
  try {
    return { value: parse(text) };
  } catch (error) {
    return { unread: `unparseable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Слияние слоёв конфига: объекты — по ключам вглубь, прочее (массивы, строки) — замена. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isRecord(base) || !isRecord(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = deepMerge(base[key], value);
  return out;
}

/** Строковые пары записи `env`; нестроковые значения CLI отверг бы — их нет. */
export function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  );
}

export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];

/**
 * Удалённый сервер человека (s10 p8): адрес обязан быть http(s); заголовки — строковые пары.
 * Не годится — причина пропуска.
 */
export function remoteEntry(
  url: unknown,
  transport: 'http' | 'sse',
  headers: Record<string, string>,
): { entry: McpRemoteEntry } | { skipped: string } {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
    return { skipped: `remote ${transport} server without an http(s) url` };
  return {
    entry: { url, transport, ...(Object.keys(headers).length > 0 ? { headers } : {}) },
  };
}

/**
 * Подстановка `${VAR}` / `${VAR:-запас}` из пина (форма Claude Code `.mcp.json`). Переменной нет и
 * запаса нет — CLI сервер не поднял бы: имя переменной в `missing`.
 */
export function expandVars(
  text: string,
  pin: Record<string, string>,
): { value: string } | { missing: string } {
  let missing: string | undefined;
  const value = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name, fallback) => {
      const got = pin[name as string];
      if (got !== undefined) return got;
      if (fallback !== undefined) return fallback as string;
      missing ??= name as string;
      return '';
    },
  );
  return missing !== undefined ? { missing } : { value };
}

/** Пустой результат с причиной пропуска проекта. */
export function emptyRead(projectSkipped?: string | null): McpSourceRead {
  return { servers: [], unread: [], ...(projectSkipped ? { projectSkipped } : {}) };
}
