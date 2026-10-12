import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caselessGlob, configDirOf, type UserMemoryPlace } from '../../platform/layers/layers.ts';
import { layoutForCwd } from '../../project-git/cwd-layout.ts';

/**
 * Копия загружает РОВНО то, что её источник (E1).
 *
 * Исключения инструкций (`claudeMdExcludes`) человек пишет под свой чекаут:
 * `**\/<проект>/**\/CLAUDE.md`, абсолютный путь к правилам. Копия лежит в
 * другом каталоге (`<проект>-worktrees/<имя>/`), шаблон её не узнаёт — и агент
 * группы получает поверх личного слоя ещё и командный `CLAUDE.md` с полным
 * набором `.claude/rules`, который в источнике снят. Замерено 12.10.2026 на 36
 * сессиях групп: контекст на первом чтении фронтенда прыгал 78k → 152k, после
 * каждого сжатия правила грузились снова — около пятой части всего входа.
 *
 * Поэтому каждый действующий шаблон, привязанный к корню источника,
 * переписывается на корень копии и едет в `--settings`. Массив из `--settings`
 * СЛИВАЕТСЯ с личным, а не заменяет его (замерено настоящим `claude` 2.1.286
 * 12.10.2026: личное `a` и наложенное `b` сняты оба), поэтому едут только
 * переписанные шаблоны.
 *
 * Граница: панель лишь повторяет исключения, которые источник делает сам.
 * Проект без исключений грузит в копии всё, как и прежде; ничего не сжимается
 * и не выбрасывается по решению панели.
 */

const ALL_SOURCES: readonly string[] = ['user', 'project', 'local'];

function activeSources(args: readonly string[]): ReadonlySet<string> {
  const at = args.indexOf('--setting-sources');
  if (at < 0) return new Set(ALL_SOURCES);
  return new Set((args[at + 1] ?? '').split(',').map((source) => source.trim()));
}

function excludesIn(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { claudeMdExcludes?: unknown };
    const list = parsed.claudeMdExcludes;
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toSlash(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** Один сегмент шаблона против одного сегмента пути; `[`, `{`, `(` — не берёмся. */
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
 * Хвосты шаблона относительно корня источника: шаблон `P` узнаёт файл
 * `<источник>/<путь>` ровно тогда, когда хвост узнаёт `<путь>`.
 *
 * Две формы привязки к источнику. Абсолютная — шаблон начинается с пути
 * источника. Плавающая `**\/a/b/…` — первые сегменты после `**` совпадают с
 * последними сегментами пути источника (перебираются все длины: `**\/work/
 * <проект>/…` и `**\/<проект>/…` одинаково законны). Где ведущие сегменты
 * совпадают с ЧАСТЬЮ относительного пути, копия узнаётся и без переписи — `**`
 * поглощает её корень так же, как корень источника. Шаблон, не привязанный
 * к источнику, копию узнаёт сам или не касается её вовсе — хвостов нет.
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

/**
 * Шаблоны `claudeMdExcludes` для прогона в копии: каждый действующий шаблон
 * источника, переписанный на корень копии. Не копия — пусто.
 *
 * Действующие — из тех же источников настроек, что включены прогону
 * (`--setting-sources`; без флага — все три): личный `settings.json` и
 * проектные `.claude/settings{,.local}.json` копии (локальный слой туда
 * переносит `mirrorLocalLayer`). Регистр — как у `userMemoryExcludes`: на
 * Windows и macOS к буквальному написанию корня добавляется шаблон
 * `[cC]:/…`, хвост остаётся шаблоном человека.
 */
export function copyParityExcludes(args: readonly string[], place: UserMemoryPlace): string[] {
  const { mainDir, copyDir } = layoutForCwd(place.cwd);
  if (!mainDir || !copyDir) return [];

  const sources = activeSources(args);
  const patterns: string[] = [];
  if (sources.has('user')) patterns.push(...excludesIn(join(configDirOf(place), 'settings.json')));
  if (sources.has('project')) {
    patterns.push(...excludesIn(join(copyDir, '.claude', 'settings.json')));
  }
  if (sources.has('local')) {
    patterns.push(...excludesIn(join(copyDir, '.claude', 'settings.local.json')));
  }

  const caseless = place.platform === 'win32' || place.platform === 'darwin';
  const copy = toSlash(copyDir);
  const mapped = new Set<string>();
  for (const pattern of patterns) {
    for (const tail of sourceTails(pattern, mainDir, caseless)) {
      mapped.add(`${copy}/${tail}`);
      if (caseless) mapped.add(`${caselessGlob(copy)}/${tail}`);
    }
  }
  return [...mapped];
}
