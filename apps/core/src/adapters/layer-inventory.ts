import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  skillFlowSchema,
  type SkillFlow,
  type UserLayerInventory,
} from '@agentdeck/contracts/core/user-layer';
import { readBytesSync } from '../platform/safe-io/files.ts';

/**
 * Общие части описи слоя человека (01:18-20, 06:114-129) для всех переходников: разбор
 * frontmatter (BOM и CRLF терпимы — файлы человека пишут и в Windows-редакторах), чтение файла
 * фактом, обход каталогов, хеш описи. Где лежат файлы и что из них берётся — знает переходник.
 */

/**
 * Префикс строки потери в `LayerRun.detail` (G-b): часть слоя, которую ни одна дорога не вернула.
 * По нему судья `layer-run` отделяет потери, а дорога пишет сигнал `layer-loss`.
 */
export const LOSS_PREFIX = 'loss: ';

export type Source = UserLayerInventory['sources'][number];
export type Unread = UserLayerInventory['unread'][number];

/** Файл прочитан (текст + хеш) или назван непрочитанным; нет файла — `null`. */
export type ReadSource = { text: string; sha256: string; bytes: number } | { unread: string };

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function readSource(path: string): ReadSource | null {
  const got = readBytesSync(path);
  if ('absent' in got) return null;
  if ('unknown' in got) return { unread: got.unknown };
  const bytes = got.value;
  return { text: bytes.toString('utf8'), sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * Файлы каталога по предикату имени, рекурсивно (`deep`) или один уровень; порядок —
 * отсортированный (опись и хеш не зависят от порядка каталога ОС). Каталог не читается —
 * назван в `unread`, а не «пусто» (F25). Ссылки не проходятся: копия слоя их не переносит.
 */
export function listFiles(
  dir: string,
  match: (name: string) => boolean,
  deep: boolean,
  unread: Unread[],
): string[] {
  const stats = statSync(dir, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) return [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    unread.push({ path: dir, reason: (error as Error).message });
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let entry;
    try {
      entry = statSync(path);
    } catch (error) {
      unread.push({ path, reason: (error as Error).message });
      continue;
    }
    if (entry.isDirectory()) {
      if (deep) out.push(...listFiles(path, match, deep, unread));
    } else if (entry.isFile() && match(name)) out.push(path);
  }
  return out;
}

/** Подкаталоги первого уровня (навыки `skills/<имя>/`), отсортированно. */
export function listDirs(dir: string, unread: Unread[]): string[] {
  const stats = statSync(dir, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) return [];
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => join(dir, name))
      .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true);
  } catch (error) {
    unread.push({ path: dir, reason: (error as Error).message });
    return [];
  }
}

// ── frontmatter: подмножество YAML, которое пишут в навыках и агентах ──

type Yaml = string | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
};

/** Ключ строки `key: value`; кавычки у ключа снимаются. */
const KEY = /^("[^"]*"|'[^']*'|[^:#\s][^:#]*?)\s*:(?:\s+(.*))?$/;

function parseBlock(lines: Line[], from: number, indent: number): [Yaml, number] {
  const first = lines[from];
  if (!first || first.indent < indent) return ['', from];
  if (first.text.startsWith('- ') || first.text === '-') {
    const list: Yaml[] = [];
    let i = from;
    while (i < lines.length && lines[i]!.indent === first.indent) {
      const line = lines[i]!;
      if (!(line.text.startsWith('- ') || line.text === '-')) break;
      const rest = line.text.slice(1).trimStart();
      if (rest === '') {
        const [item, next] = parseBlock(lines, i + 1, first.indent + 1);
        list.push(item);
        i = next;
        continue;
      }
      // `- key: value` — элемент-словарь: ключи элемента выровнены по тексту после «- ».
      if (KEY.test(rest)) {
        const inner = first.indent + (line.text.length - rest.length);
        const sub: Line[] = [{ indent: inner, text: rest }];
        let j = i + 1;
        while (j < lines.length && lines[j]!.indent > first.indent) sub.push(lines[j++]!);
        list.push(parseBlock(sub, 0, inner)[0]);
        i = j;
        continue;
      }
      list.push(unquote(rest));
      i++;
    }
    return [list, i];
  }
  const map: Record<string, Yaml> = {};
  let i = from;
  while (i < lines.length && lines[i]!.indent === first.indent) {
    const m = KEY.exec(lines[i]!.text);
    if (!m) {
      i++;
      continue;
    }
    const key = unquote(m[1]!);
    const inline = (m[2] ?? '').trim();
    if (inline !== '' && !inline.startsWith('#')) {
      map[key] = unquote(inline);
      i++;
      continue;
    }
    const next = lines[i + 1];
    if (next && next.indent > first.indent) {
      const [value, after] = parseBlock(lines, i + 1, next.indent);
      map[key] = value;
      i = after;
    } else if (next && next.indent === first.indent && next.text.startsWith('-')) {
      // Список на том же отступе, что ключ (`key:\n- a`) — так тоже пишут.
      const [value, after] = parseBlock(lines, i + 1, next.indent);
      map[key] = value;
      i = after;
    } else {
      map[key] = '';
      i++;
    }
  }
  return [map, i];
}

export interface Frontmatter {
  /** Ключи верхнего уровня; значения — строки, списки и словари (подмножество YAML). */
  data: Record<string, Yaml>;
  /** Текст после закрывающей черты. */
  body: string;
}

/**
 * Frontmatter `---` … `---` в начале файла. BOM и CRLF снимаются до разбора; нет блока —
 * `null` (файл без frontmatter — не порча). Табы в отступах считаются за один пробел.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!clean.startsWith('---\n')) return null;
  const end = clean.indexOf('\n---', 3);
  if (end < 0) return null;
  const after = clean.indexOf('\n', end + 1);
  const raw = clean.slice(4, end + 1);
  const lines: Line[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.replace(/^[ \t]+/, '').length;
    lines.push({ indent, text: line.trim() });
  }
  const data: Yaml = lines.length > 0 ? parseBlock(lines, 0, lines[0]!.indent)[0] : {};
  return {
    data: typeof data === 'object' && !Array.isArray(data) ? data : {},
    body: after < 0 ? '' : clean.slice(after + 1),
  };
}

const str = (value: Yaml | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Поток навыка из `agentdeck.steps` (02:33) и прочие ключи `agentdeck.*` (их ядро не знает —
 * названы, не молча). Поток не по схеме — `null` и ключ `steps` в прочих.
 */
export function skillFlowOf(fm: Frontmatter | null): {
  flow: SkillFlow | null;
  extraKeys: string[];
} {
  const block = fm?.data.agentdeck;
  if (!block || typeof block !== 'object' || Array.isArray(block))
    return { flow: null, extraKeys: [] };
  const extraKeys = Object.keys(block)
    .filter((key) => key !== 'steps')
    .map((key) => `agentdeck.${key}`);
  if (block.steps === undefined) return { flow: null, extraKeys };
  const parsed = skillFlowSchema.safeParse({ steps: block.steps });
  if (!parsed.success) return { flow: null, extraKeys: [...extraKeys, 'agentdeck.steps'] };
  return { flow: parsed.data, extraKeys };
}

export const nameOf = (fm: Frontmatter | null, fallback: string): string =>
  str(fm?.data.name) ?? fallback;

/** Модель агента; `inherit` и пусто — `null` (наследует модель сеанса). */
export function agentModelOf(fm: Frontmatter | null): string | null {
  const model = str(fm?.data.model);
  return model && model !== 'inherit' ? model : null;
}

/** Навык или агент со своими хуками (`hooks` во frontmatter) — исполнил бы хук в observe/off. */
export const carriesHooks = (fm: Frontmatter | null): boolean => fm?.data.hooks !== undefined;

// ── хеш описи ──

/** Канонический JSON: ключи отсортированы на каждом уровне. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Хеш описи (01:18): отсортированный список (путь, sha256 | `unread:<причина>`) + канонический
 * JSON настроек. Непрочитанный файл входит в хеш как непрочитанный — «не знаю» не равно «пусто».
 */
export function inventoryHash(
  sources: readonly Source[],
  unread: readonly Unread[],
  settings: unknown,
): string {
  const rows = [
    ...sources.map((s) => `${s.path}\0${s.sha256}`),
    ...unread.map((u) => `${u.path}\0unread:${u.reason}`),
  ].sort();
  return sha256(`${rows.join('\n')}\n--settings\n${canonicalJson(settings)}`);
}
