import { join } from 'node:path';
import { READ_CLASSES } from '../../lib/facts/read-classes.ts';
import type { OsKind } from '../../platform/os-kind.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { samePath } from '../../platform/paths.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Копия загружает РОВНО то, что её источник (E1), — перенос `copy-parity` панели в ядро.
 *
 * Исключения инструкций (`claudeMdExcludes`) человек пишет под свой чекаут
 * (`**\/<проект>/**\/CLAUDE.md`, абсолютный путь к правилам). Копия лежит в другом каталоге,
 * шаблон её не узнаёт, и сессия в копии получала командный `CLAUDE.md` и `.claude/rules`,
 * которые в источнике сняты (панель мерила 12.10.2026: 78k → 152k на первом чтении). Поэтому
 * каждый шаблон, привязанный к корню источника, переписывается на корень копии и едет в
 * `--settings`: массив оттуда СЛИВАЕТСЯ с личным, значит едут только переписанные.
 *
 * Только для слоя `on`: в `observe`/`off` ядро не грузит файлы человека вовсе
 * (`--setting-sources ''`), исключать нечего. Ничего не сжимается по решению ядра — только
 * повтор того, что источник делает сам. Нечитаемый файл настроек — класс `layer.settings`:
 * сессия идёт без его шаблонов, и это названо в `layerDetail`, а не пропущено молча.
 */

const BOM = 0xfeff;

function toSlash(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** Шаблон пути без учёта регистра: `[cC]:/[uU]…` (как `caselessGlob` панели). */
export function caselessGlob(path: string): string {
  if (/[[\]!]/.test(path)) return path;
  return [...path]
    .map((ch) => {
      if ('(){}*?+@'.includes(ch)) return `[${ch}]`;
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper || lower.length !== 1 || upper.length !== 1
        ? ch
        : `[${lower}${upper}]`;
    })
    .join('');
}

/** Один сегмент шаблона против одного сегмента пути; `[`, `{`, `(`, `!` — не берёмся. */
function segmentMatches(segment: string, part: string, caseless: boolean): boolean {
  if (/[[{(!]/.test(segment)) return false;
  const source = segment
    .split('')
    .map((ch) => {
      if (ch === '*') return '[^/]*';
      if (ch === '?') return '[^/]';
      return ch.replace(/[.+^$|\\)\]}]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, caseless ? 'i' : '').test(part);
}

/**
 * Хвосты шаблона относительно корня источника: шаблон узнаёт `<источник>/<путь>` ровно тогда,
 * когда хвост узнаёт `<путь>`. Абсолютная привязка — шаблон начинается с пути источника;
 * плавающая `**\/a/b/…` — первые сегменты после `**` совпадают с последними сегментами пути
 * источника (все длины). Не привязанный к источнику шаблон копию узнаёт сам или не касается её.
 */
export function sourceTails(pattern: string, sourceRoot: string, caseless: boolean): string[] {
  const p = toSlash(pattern);
  const root = toSlash(sourceRoot);
  const head = p.slice(0, root.length);
  if (
    p.length > root.length + 1 &&
    p[root.length] === '/' &&
    (caseless ? head.toLowerCase() === root.toLowerCase() : head === root)
  ) {
    return [p.slice(root.length + 1)];
  }
  if (!p.startsWith('**/')) return [];
  const body = p.slice(3).split('/');
  const rootParts = root.split('/').filter(Boolean);
  const tails: string[] = [];
  for (let k = 1; k < body.length && k <= rootParts.length; k += 1) {
    const lead = body.slice(0, k);
    if (lead.some((segment) => segment.includes('**'))) break;
    const anchored = lead.every((segment, i) =>
      segmentMatches(segment, rootParts[rootParts.length - k + i] ?? '', caseless),
    );
    if (anchored) tails.push(body.slice(k).join('/'));
  }
  return tails;
}

type Read = { patterns: string[] } | { unknown: string };

/** `claudeMdExcludes` одного файла настроек; нет файла — пусто, сбой или не JSON — `unknown`. */
function excludesIn(file: string, read: typeof readBytesSync): Read {
  const got = read(file);
  if ('absent' in got) return { patterns: [] };
  if ('unknown' in got) return { unknown: got.unknown };
  const text = got.value.toString('utf8');
  try {
    // Файл, сохранённый блокнотом Windows, начинается с BOM — это не порча.
    const parsed = JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text) as {
      claudeMdExcludes?: unknown;
    };
    const list = parsed?.claudeMdExcludes;
    return {
      patterns: Array.isArray(list)
        ? list.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch (error) {
    return { unknown: `not JSON: ${(error as Error).message}` };
  }
}

export interface CopyParityInput {
  /** Исходный репозиторий (`spec.trust.sourceRepo`). */
  sourceRepo: string;
  /** Корень копии (`spec.cwd`). */
  cwd: string;
  /** Окружение сессии: где личный каталог CLI (`CLAUDE_CONFIG_DIR` / HOME). */
  pin: Record<string, string>;
  os?: OsKind;
  /** Для тестов — подменное чтение; иначе `readBytesSync`. */
  read?: typeof readBytesSync;
}

export interface CopyParity {
  excludes: string[];
  /** Для `layerDetail`: сколько шаблонов перенесено и какие файлы не прочлись. */
  detail: string | null;
}

export function copyParity(input: CopyParityInput): CopyParity {
  const os = input.os ?? currentOs();
  if (samePath(input.sourceRepo, input.cwd, os)) return { excludes: [], detail: null };
  const read = input.read ?? readBytesSync;
  const files = [
    join(claudeConfigDir(input.pin), 'settings.json'),
    join(input.cwd, '.claude', 'settings.json'),
    join(input.cwd, '.claude', 'settings.local.json'),
  ];
  const patterns: string[] = [];
  const unread: string[] = [];
  for (const file of files) {
    const got = excludesIn(file, read);
    // Класс `layer.settings` (`onUnknown: run`): сессия идёт без переписи этого файла, названо.
    if ('unknown' in got) {
      unread.push(`${file}: ${got.unknown} → ${READ_CLASSES['layer.settings'].onUnknown}`);
      continue;
    }
    patterns.push(...got.patterns);
  }
  const caseless = os === 'win32' || os === 'darwin';
  const copy = toSlash(input.cwd);
  const mapped = new Set<string>();
  for (const pattern of patterns) {
    for (const tail of sourceTails(pattern, input.sourceRepo, caseless)) {
      mapped.add(`${copy}/${tail}`);
      if (caseless) mapped.add(`${caselessGlob(copy)}/${tail}`);
    }
  }
  const excludes = [...mapped];
  const notes = [
    ...(excludes.length > 0
      ? [`copy parity: ${excludes.length} claudeMdExcludes rewritten to the copy`]
      : []),
    ...unread.map((u) => `copy parity: settings unread, not rewritten (${u})`),
  ];
  return { excludes, detail: notes.length > 0 ? notes.join('; ') : null };
}
