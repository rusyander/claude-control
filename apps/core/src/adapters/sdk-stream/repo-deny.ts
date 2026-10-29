import { join, resolve } from 'node:path';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import type { SessionSpec } from '../adapter.types.ts';

/**
 * Запреты репозитория в недоверенной копии (F-86). Файлы настроек репозитория до сеанса не
 * доходят (их хуки, `env`, MCP и разрешения пишет кто угодно с доступом к репозиторию), но его
 * `deny` только сужает сеанс — он читается ДАННЫМИ и уходит в настройки ядра. Читаются корни
 * исходного репозитория и копии: `settings.local.json` обычно вне git и есть только у источника.
 * Файл есть, но не разобран — запуск отказывается: запреты не теряются молча (F-35).
 */

/** Файл настроек и пути к спискам запретов в нём (`permissions.deny`, у Qwen и `tools.exclude`). */
export interface RepoDenySource {
  path: string;
  fields: readonly (readonly [string, string])[];
  /** Файл JSONC (комментарии) — так его читает CLI (Qwen: `strip-json-comments`). */
  jsonc?: boolean;
}

export interface RepoDeny {
  /**
   * Правила без повтора. Правило пути от корня репозитория (`/x`) относится к копии так же, как к
   * источнику: файл, который репозиторий закрыл, лежит в копии под тем же путём.
   */
  rules: string[];
  /** Правила, которые закрыли бы инструменты ядра (сервер права, серверы шага), — не идут. */
  dropped: string[];
  read: string[];
  /** Файл и почему не разобран. */
  unreadable: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Корни, чьи запреты читаются: исходный репозиторий и копия, без повтора. */
export function repoDenyRoots(spec: SessionSpec): string[] {
  const roots = [spec.trust?.sourceRepo, spec.cwd].filter((r): r is string => !!r);
  // Регистр не сводится: на Linux `Repo` и `repo` — разные каталоги, лишнее чтение безвредно.
  return [...new Set(roots.map((root) => resolve(root)))];
}

/** Файлы запретов под каждым корнем: `<root>/<dir>/<name>` для каждого имени. */
export function repoDenySources(
  roots: readonly string[],
  dir: string,
  names: readonly string[],
  fields: RepoDenySource['fields'],
  jsonc = false,
): RepoDenySource[] {
  return roots.flatMap((root) =>
    names.map((name) => ({
      path: join(root, dir, name),
      fields,
      ...(jsonc ? { jsonc } : {}),
    })),
  );
}

/**
 * Комментарии JSONC (`//` до конца строки, `/* … *\/`) вне строк заменяются пробелами — как у
 * `strip-json-comments`, которым Qwen читает свои настройки. Висящие запятые не прощаются: CLI
 * их тоже не прощает.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Объект файла настроек, как его читает CLI; `null` — файла нет; `why` — не разобран. */
export function readSettingsObject(
  path: string,
  jsonc = false,
): { value: Record<string, unknown> } | { why: string } | null {
  const bytes = readBytesSync(path);
  if ('absent' in bytes) return null;
  if ('unknown' in bytes) return { why: bytes.unknown };
  const raw = bytes.value.toString('utf8');
  // Метка порядка байтов (U+FEFF) в начале — не текст JSON.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc ? stripJsonComments(text) : text);
  } catch (error) {
    return { why: `not JSON (${(error as Error).message})` };
  }
  if (!isRecord(parsed)) return { why: 'not an object' };
  return { value: parsed };
}

/** Строки запретов файла или причина, по которой файл не разобран. */
function readSource(source: RepoDenySource): { rules: string[] } | { why: string } | null {
  const got = readSettingsObject(source.path, source.jsonc);
  if (got === null || 'why' in got) return got;
  const parsed = got.value;
  const rules: string[] = [];
  for (const [parent, leaf] of source.fields) {
    const holder = parsed[parent];
    if (holder === undefined) continue;
    if (!isRecord(holder)) return { why: `${parent} is not an object` };
    const list = holder[leaf];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { why: `${parent}.${leaf} is not an array` };
    rules.push(...list.filter((v): v is string => typeof v === 'string' && v.trim() !== ''));
  }
  return { rules };
}

/** Имя инструмента правила: до `(`. */
const toolOf = (rule: string): string => {
  const at = rule.indexOf('(');
  return (at === -1 ? rule : rule.slice(0, at)).trim();
};

/**
 * Правило, которое закрыло бы инструмент ядра: `mcp__<сервер>…` сервера шага или сервера права,
 * и любое правило с маской в имени инструмента (`*`, `mcp__*`, `mcp__perm*`) — оно задело бы их
 * тоже. Встроенные инструменты CLI не трогаются: запрет на них — право репозитория.
 */
export function deniesCoreTool(rule: string, coreServers: ReadonlySet<string>): boolean {
  const tool = toolOf(rule);
  if (/[*?]/.test(tool)) return true;
  if (!tool.startsWith('mcp__')) return false;
  const server = tool.slice('mcp__'.length).split('__')[0] ?? '';
  return coreServers.has(server);
}

/** Серверы ядра в сеансе: серверы шага и сервер права. */
export function coreServers(spec: SessionSpec): Set<string> {
  return new Set([
    ...Object.keys(spec.mcpServers),
    ...(spec.permitServer ? [spec.permitServer.name] : []),
  ]);
}

export function readRepoDeny(
  sources: readonly RepoDenySource[],
  core: ReadonlySet<string>,
): RepoDeny {
  const out: RepoDeny = { rules: [], dropped: [], read: [], unreadable: [] };
  for (const source of sources) {
    const got = readSource(source);
    if (got === null) continue;
    if ('why' in got) {
      out.unreadable.push(`${source.path}: ${got.why}`);
      continue;
    }
    out.read.push(source.path);
    for (const rule of got.rules) {
      const list = deniesCoreTool(rule, core) ? out.dropped : out.rules;
      if (!list.includes(rule)) list.push(rule);
    }
  }
  return out;
}

/** Строка журнала: сколько запретов репозитория дошло и какие сняты. */
export function repoDenyDetail(deny: RepoDeny): string | undefined {
  if (deny.read.length === 0) return undefined;
  const carried = deny.rules.length;
  const dropped =
    deny.dropped.length > 0 ? `; dropped (would deny core tools): ${deny.dropped.join(', ')}` : '';
  return `${carried} repo deny rules carried from ${deny.read.join(', ')}${dropped}`;
}

/** Отказ запуска: файл запретов репозитория есть, но не разобран. */
export function repoDenyRefusal(deny: RepoDeny): string | null {
  if (deny.unreadable.length === 0) return null;
  return `repo settings unreadable, their deny rules would be lost: ${deny.unreadable.join('; ')}`;
}
