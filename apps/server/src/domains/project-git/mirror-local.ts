import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeMirrorReport, WorktreeMirrorSettings } from '@agentdeck/contracts';
import { git } from './exec.ts';

/**
 * Локальный слой репозитория — в копию, без вопросов.
 *
 * `git worktree add` выкладывает чистый чекаут: всё, чего git не хранит, в копии
 * отсутствует. А это ровно то, чем живёт агент в ЭТОМ проекте: `.mcp.json`
 * (в enterprise-platform он `skip-worktree`), `.claude/**` с хуками, скиллами и локальными
 * правами, `CLAUDE.local.md`, `.agent/**` с тикетами, `.dev/` с секретами
 * стенда, `.env*`. Без них первый ход агента в копии — «настройка worktree», а
 * записать их сам он не может: панель как раз запрещает ему трогать чужие
 * каталоги. Поэтому переносим сами, сразу после создания копии, и повторяем по
 * кнопке.
 *
 * Два источника: файлы с флагом `skip-worktree` / `assume-unchanged` в основной
 * копии (берётся РАБОЧАЯ версия, и в копии ставится тот же флаг) и игнорируемое
 * git по списку шаблонов — встроенному плюс тому, что человек дописал на
 * проекте. Никогда: `node_modules`, `dist`, `build`, `coverage`, `.turbo`,
 * `.cache`, `*.log` и файлы больше 8 МБ — они называются в отчёте. Отчёт
 * называет и игнорируемое верхнего уровня, что осталось за бортом: по нему
 * человек дополняет список. Ссылки не копируются: junction на скиллы — не в
 * объёме.
 */

export const MIRROR_SIZE_LIMIT = 8 * 1024 * 1024;

/** Встроенный список: что переносится всегда. Без «/» — по имени на любой глубине. */
export const DEFAULT_INCLUDE: readonly string[] = [
  '.mcp.json',
  '.claude/**',
  'CLAUDE.local.md',
  '.agent/**',
  '.env',
  '.env.*',
  '*.local',
  '*.local.*',
  '.dev/**',
];

/** Встроенные вычеты: рабочий мусор `.agent/`, который копии не нужен. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  '.agent/tmp/**',
  '.agent/screenshots/**',
  '.agent/archive/**',
  '.agent/PROGRESS*.md',
];

/** Каталоги, внутрь которых зеркало не заходит никогда, где бы они ни лежали. */
const NEVER_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.cache']);
const NEVER_FILES = ['*.log'];

/** Пусто — значит только встроенное. */
export function emptyMirrorSettings(): WorktreeMirrorSettings {
  return { include: [], exclude: [] };
}

/**
 * Шаблон в регулярное выражение по правилам `.gitignore`, которых хватает
 * человеку: `**` — любая глубина (и ноль сегментов), `*` — внутри сегмента, `?`
 * — один символ. Шаблон без «/» сравнивается с именем файла на любой глубине,
 * с «/» — с путём от корня репозитория.
 */
export function globToRegExp(pattern: string): RegExp {
  const clean = pattern
    .trim()
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i] as string;
    if (char === '*') {
      if (clean[i + 1] === '*') {
        // `**/` — ноль или больше сегментов; `**` в конце — всё, что дальше.
        if (clean[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

interface Matcher {
  test(path: string): boolean;
}

function matcherFor(pattern: string): Matcher | undefined {
  const clean = pattern.trim();
  if (!clean || clean.startsWith('#')) return undefined;
  const regExp = globToRegExp(clean);
  const byName = !clean.replace(/\/+$/, '').includes('/');
  return byName
    ? { test: (path) => regExp.test(path.slice(path.lastIndexOf('/') + 1)) }
    : { test: (path) => regExp.test(path) };
}

function matchers(patterns: readonly string[]): Matcher[] {
  return patterns.map(matcherFor).filter((item): item is Matcher => item !== undefined);
}

/** Относительный путь с прямыми слэшами — так его называет git и так его сравниваем. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Что-то из запретного списка на пути или в имени. */
export function isNever(path: string): boolean {
  const parts = normalize(path).split('/');
  if (parts.some((segment) => NEVER_DIRS.has(segment))) return true;
  return matchers(NEVER_FILES).some((item) => item.test(normalize(path)));
}

/** Встроенные списки плюс дописанное человеком. */
export function effectiveSettings(user: WorktreeMirrorSettings | undefined): {
  include: string[];
  exclude: string[];
} {
  return {
    include: [...DEFAULT_INCLUDE, ...(user?.include ?? [])],
    exclude: [...DEFAULT_EXCLUDE, ...(user?.exclude ?? [])],
  };
}

/** Файл назван в списке — неважно, вычтен ли потом. */
export function listed(path: string, include: readonly string[]): boolean {
  const relPath = normalize(path);
  return matchers(include).some((item) => item.test(relPath));
}

/** Подходит ли файл под зеркало: есть в списке, не вычтен, не запретный. */
export function wanted(path: string, settings: { include: string[]; exclude: string[] }): boolean {
  const relPath = normalize(path);
  if (isNever(relPath)) return false;
  if (!listed(relPath, settings.include)) return false;
  return !matchers(settings.exclude).some((item) => item.test(relPath));
}

/**
 * Может ли шаблон с «/» найти что-то ВНУТРИ свёрнутого игнорируемого каталога.
 * Шаблоны по имени сюда не считаются: ради `*.local` обходить каждый `.venv`
 * значило бы обходить всё; такой каталог просто называется в отчёте.
 */
export function includeReaches(dir: string, include: readonly string[]): boolean {
  const relDir = normalize(dir);
  return include.some((pattern) => {
    const clean = pattern.trim().replace(/^\.?\//, '');
    if (!clean.replace(/\/+$/, '').includes('/')) return false;
    if (clean.startsWith('**/')) return true;
    const head = clean.split('/')[0] as string;
    return head === relDir.split('/')[0] || globToRegExp(head).test(relDir.split('/')[0] as string);
  });
}

export type MirrorFlag = 'skip-worktree' | 'assume-unchanged';

export interface FlaggedEntry {
  path: string;
  flag: MirrorFlag;
}

/**
 * `git ls-files -v -z`: буква перед путём. `S` — skip-worktree, строчная буква —
 * assume-unchanged (`s` — оба флага разом, для зеркала это skip-worktree).
 */
export function parseFlagged(stdout: string): FlaggedEntry[] {
  const result: FlaggedEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 3) continue;
    const tag = record[0] as string;
    const path = record.slice(2);
    if (tag === 'S' || tag === 's') result.push({ path, flag: 'skip-worktree' });
    else if (tag === 'h') result.push({ path, flag: 'assume-unchanged' });
  }
  return result;
}

/** `git ls-files --others --ignored --exclude-standard --directory -z`: каталоги с «/» на конце. */
export function parseIgnored(stdout: string): string[] {
  return stdout.split('\0').filter((item) => item.length > 0);
}

export interface MirrorPlan {
  /** Файлы под зеркало с относительными путями (POSIX). */
  files: string[];
  /** Флаги, которые надо поставить в копии. */
  flagged: FlaggedEntry[];
  /** Игнорируемое верхнего уровня, что в списке не значится. */
  unlisted: string[];
}

/**
 * Что переносить. Чистая часть: списки от git и обход каталогов — снаружи,
 * чтобы правила проверялись без репозитория.
 */
export function planMirror(input: {
  flagged: FlaggedEntry[];
  ignored: string[];
  settings: WorktreeMirrorSettings | undefined;
  /** Файлы внутри свёрнутого игнорируемого каталога (относительно корня). */
  listDir: (dir: string) => string[];
}): MirrorPlan {
  const settings = effectiveSettings(input.settings);
  const files = new Set<string>();
  const unlisted: string[] = [];

  for (const entry of input.flagged) {
    if (!isNever(entry.path)) files.add(normalize(entry.path));
  }

  for (const raw of input.ignored) {
    const isDir = raw.endsWith('/');
    const path = normalize(raw);
    const topLevel = !path.includes('/');
    if (isNever(path)) continue;
    if (isDir) {
      if (includeReaches(path, settings.include)) {
        for (const file of input.listDir(path)) {
          if (wanted(file, settings)) files.add(normalize(file));
        }
      } else if (topLevel) {
        unlisted.push(`${path}/`);
      }
      continue;
    }
    if (wanted(path, settings)) files.add(path);
    // Вычтенное человеком «за бортом» не называется: он это уже решил.
    else if (topLevel && !listed(path, settings.include)) unlisted.push(path);
  }

  return {
    files: [...files].sort(),
    flagged: input.flagged.filter((entry) => files.has(normalize(entry.path))),
    unlisted: unlisted.sort(),
  };
}

/** Обход каталога с диска: запретные каталоги и ссылки не заходятся. */
export function listFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      let info;
      try {
        info = lstatSync(join(root, relPath));
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!NEVER_DIRS.has(name)) walk(relPath);
      } else if (info.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk(normalize(dir));
  return out;
}

/** Ставит флаги в копии пачками: путей может быть много, аргументы — не безразмерные. */
async function applyFlags(copyDir: string, flagged: FlaggedEntry[]): Promise<string[]> {
  const failed: string[] = [];
  for (const flag of ['skip-worktree', 'assume-unchanged'] as const) {
    const paths = flagged.filter((entry) => entry.flag === flag).map((entry) => entry.path);
    for (let i = 0; i < paths.length; i += 50) {
      const chunk = paths.slice(i, i + 50);
      try {
        await git(copyDir, ['update-index', `--${flag}`, '--', ...chunk]);
      } catch {
        failed.push(...chunk);
      }
    }
  }
  return failed;
}

/**
 * Перенести локальный слой из основной копии в копию.
 *
 * `newerOnly` — повторное зеркало по кнопке: перезаписывается только то, что в
 * основной копии свежее; при создании копии переносится всё (в чекауте лежит
 * закоммиченная версия файла с флагом, и по времени она «свежее» рабочей).
 * Время файла переносится вместе с ним — так повторное зеркало сразу после
 * первого ничего не переписывает.
 */
export async function mirrorLocalLayer(
  mainDir: string,
  copyDir: string,
  settings: WorktreeMirrorSettings | undefined,
  options: { newerOnly?: boolean } = {},
): Promise<WorktreeMirrorReport> {
  const [flaggedOut, ignoredOut] = await Promise.all([
    git(mainDir, ['ls-files', '-v', '-z']),
    git(mainDir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
  ]);
  const plan = planMirror({
    flagged: parseFlagged(flaggedOut),
    ignored: parseIgnored(ignoredOut),
    settings,
    listDir: (dir) => listFilesUnder(mainDir, dir),
  });

  const report: WorktreeMirrorReport = {
    mirrored: [],
    skipped: [],
    unlisted: plan.unlisted,
    kept: 0,
  };
  const copied = new Set<string>();

  for (const relPath of plan.files) {
    const src = join(mainDir, relPath);
    const dst = join(copyDir, relPath);
    let info;
    try {
      info = lstatSync(src);
    } catch {
      report.skipped.push({ path: relPath, reason: 'нет в основной копии' });
      continue;
    }
    if (info.isSymbolicLink()) {
      report.skipped.push({ path: relPath, reason: 'ссылка' });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MIRROR_SIZE_LIMIT) {
      report.skipped.push({
        path: relPath,
        reason: `больше 8 МБ (${Math.round(info.size / 1024 / 1024)} МБ)`,
      });
      continue;
    }
    if (options.newerOnly && existsSync(dst)) {
      const current = statSync(dst);
      if (current.mtimeMs + 1000 >= info.mtimeMs) {
        report.kept += 1;
        continue;
      }
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      utimesSync(dst, info.atime, info.mtime);
      report.mirrored.push(relPath);
      copied.add(relPath);
    } catch (error) {
      report.skipped.push({
        path: relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Флаг ставится и на то, что уже было свежим: копия могла потерять его сама.
  const failed = await applyFlags(
    copyDir,
    plan.flagged.filter((entry) => copied.has(normalize(entry.path)) || options.newerOnly),
  );
  for (const path of failed) report.skipped.push({ path, reason: 'флаг git не поставлен' });

  return report;
}

/** Одна строка для тоста и вывода: что перенесено, что пропущено, что осталось. */
export function describeMirror(report: WorktreeMirrorReport): string {
  const parts = [`Локальный слой: перенесено ${report.mirrored.length}`];
  if (report.kept > 0) parts.push(`без изменений ${report.kept}`);
  if (report.skipped.length > 0) parts.push(`пропущено ${report.skipped.length}`);
  if (report.unlisted.length > 0) parts.push(`за бортом: ${report.unlisted.join(', ')}`);
  return parts.join(', ');
}
