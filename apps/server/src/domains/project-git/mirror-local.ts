import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  WorktreeMirrorReport,
  WorktreeMirrorSettings,
  WorktreeMirrorSkipped,
} from '@agentdeck/contracts';
import { serverText } from '../../lib/server-texts.ts';
import { git } from './exec.ts';

/**
 * Локальный слой репозитория — в копию, без вопросов.
 *
 * `git worktree add` выкладывает чистый чекаут: всё, чего git не хранит, в копии
 * отсутствует. А это ровно то, чем живёт агент в ЭТОМ проекте: `.mcp.json`
 * (в рабочем репозитории владельца он `skip-worktree`), `.claude/**` с хуками, скиллами и локальными
 * правами, `CLAUDE.local.md`, `.agent/**` с тикетами, `.dev/` с секретами
 * стенда, `.env*`. Без них первый ход агента в копии — «настройка worktree», а
 * записать их сам он не может: панель как раз запрещает ему трогать чужие
 * каталоги. Поэтому переносим сами, сразу после создания копии, и повторяем по
 * кнопке.
 *
 * ЧЕТЫРЕ источника, и каждый закрывает свою дыру:
 * 1. файлы с флагом `skip-worktree` / `assume-unchanged` (рабочая версия, флаг
 *    ставится и в копии);
 * 2. игнорируемое git по списку шаблонов — встроенному плюс дописанному на проекте;
 * 3. НЕОТСЛЕЖИВАЕМОЕ и при этом НЕ игнорируемое по тому же списку: `.mcp.json`
 *    без строки в `.gitignore` не виден ни первому источнику, ни второму, и
 *    копия оставалась без переходников — агент в ней начинал с вопроса;
 * 4. отслеживаемое и локально изменённое по тому же списку: в чекауте копии
 *    лежит ЗАКОММИЧЕННАЯ версия, то есть чужая, без того, что человек дописал.
 * Третий и четвёртый источники берут только то, что названо в списке, — иначе
 * зеркало тащило бы в копию всю незакоммиченную работу.
 *
 * Никогда: окружение сборки и установки целиком (`NEVER_DIRS` — от
 * `node_modules` и `dist` до `.venv`, `.gradle`, `target`), `*.log` и файлы
 * больше 8 МБ — они называются в отчёте. Отчёт называет и
 * игнорируемое верхнего уровня, что осталось за бортом: по нему человек
 * дополняет список. Ссылки из основной копии не копируются, но `.claude/skills`
 * и `.claude/hooks` сами кладутся в копию ССЫЛКОЙ (`LINK_DIRS`): правка скилла
 * в оригинале сразу видна во всех копиях, а расхождение версий скиллов между
 * копиями — это агент, работающий по вчерашним правилам.
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
  '*.env',
  '*.local',
  '*.local.*',
  '.dev/**',
  // Проектный слой остальных CLI: у копии он такой же, как у оригинала, иначе
  // агент чужого CLI в копии остаётся без своих переходников и правил.
  '.codex/**',
  '.gemini/**',
  '.qwen/**',
  '.continue/**',
  '.goose/**',
  '.cursor/**',
  '.opencode/**',
  '.aider.conf.yml',
  '.aider.model.settings.yml',
  'AGENTS.local.md',
  'GEMINI.local.md',
];

/** Встроенные вычеты: рабочий мусор `.agent/`, который копии не нужен. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  '.agent/tmp/**',
  '.agent/screenshots/**',
  '.agent/archive/**',
  '.agent/PROGRESS*.md',
];

/**
 * Каталоги, внутрь которых зеркало не заходит никогда, где бы они ни лежали.
 *
 * Все они — результат сборки или установки, и копия обязана получить их СВОЕЙ
 * сборкой, а не копированием: внутри лежат абсолютные пути оригинала (`.venv`,
 * `.gradle`), бинарники под конкретную платформу и гигабайты, которые на
 * Windows ещё и упираются в предел длины пути. Список закрыт наглухо, ДО
 * пользовательских шаблонов (`isNever` спрашивают первым): человек, дописавший
 * в «Настройку копий» что-нибудь широкое, иначе утащил бы в копию весь
 * `node_modules`, а копия всё равно не заработала бы. Чего не хватает —
 * доставляет команда после создания копии (`bootstrap.ts`).
 */
const NEVER_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.cxx',
  'target',
  'Pods',
  '.terraform',
]);
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

/** `git ls-files --others --exclude-standard -z` и `git diff --name-only -z HEAD`: просто пути. */
export function parsePaths(stdout: string): string[] {
  return stdout.split('\0').filter((item) => item.length > 0);
}

export interface MirrorPlan {
  /** Файлы под зеркало с относительными путями (POSIX). */
  files: string[];
  /** Флаги, которые надо поставить в копии. */
  flagged: FlaggedEntry[];
  /** Игнорируемое верхнего уровня, что в списке не значится. */
  unlisted: string[];
  /**
   * Окружение сборки верхнего уровня (`NEVER_DIRS`): в копию не идёт никогда,
   * но и молчать о нём нельзя — человек ищет свой `.venv` в копии и должен
   * прочесть, что его ставит команда после создания копии, а не зеркало.
   */
  built: string[];
}

/**
 * Что переносить. Чистая часть: списки от git и обход каталогов — снаружи,
 * чтобы правила проверялись без репозитория.
 */
export function planMirror(input: {
  flagged: FlaggedEntry[];
  ignored: string[];
  /** Неотслеживаемое и не игнорируемое: git о нём молчит обоим спискам выше. */
  others?: string[];
  /** Отслеживаемое с местными правками: в чекауте копии лежала бы версия коммита. */
  modified?: string[];
  settings: WorktreeMirrorSettings | undefined;
  /** Файлы внутри свёрнутого игнорируемого каталога (относительно корня). */
  listDir: (dir: string) => string[];
}): MirrorPlan {
  const settings = effectiveSettings(input.settings);
  const files = new Set<string>();
  const unlisted: string[] = [];
  const built: string[] = [];

  for (const entry of input.flagged) {
    if (!isNever(entry.path)) files.add(normalize(entry.path));
  }

  for (const raw of input.ignored) {
    const isDir = raw.endsWith('/');
    const path = normalize(raw);
    const topLevel = !path.includes('/');
    if (isNever(path)) {
      // Молча пропасть такой КАТАЛОГ не имеет права: человек пойдёт искать в
      // копии свой `.venv` и должен прочесть, почему его там нет. Логи — другое
      // дело: их отсутствие в копии никого не удивляет и объяснений не просит.
      if (topLevel && isDir) built.push(`${path}/`);
      continue;
    }
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

  // Третий и четвёртый источники: только названное в списке, без «за бортом» —
  // незакоммиченная работа не наше дело, её переносит сам git при переключении.
  for (const raw of [...(input.others ?? []), ...(input.modified ?? [])]) {
    const path = normalize(raw);
    if (path && wanted(path, settings)) files.add(path);
  }

  return {
    files: [...files].sort(),
    flagged: input.flagged.filter((entry) => files.has(normalize(entry.path))),
    unlisted: unlisted.sort(),
    built: built.sort(),
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

/**
 * Каталоги, которые копия получает ССЫЛКОЙ, а не копией.
 *
 * Скиллы и хуки — правила работы агента, а не его данные: поправив скилл в
 * оригинале, человек ждёт, что по нему пойдут ВСЕ копии, а не только следующая.
 * Копия делала расхождение молча. Ссылка на Windows — junction (права
 * администратора не нужны), на остальных — символическая ссылка на каталог.
 * Список намеренно короткий: `settings.json` копии ссылкой быть не должен —
 * иначе разрешение, выданное в одной копии, молча появляется во всех.
 */
export const LINK_DIRS: readonly string[] = ['.claude/skills', '.claude/hooks'];

export interface LinkResult {
  linked: string[];
  failed: WorktreeMirrorSkipped[];
}

/**
 * Разложить ссылки до копирования файлов. Уже существующий в копии путь не
 * трогаем: там либо такая же ссылка, либо каталог с правками копии — удалять
 * чужую работу зеркало не вправе.
 */
export function linkSharedDirs(mainDir: string, copyDir: string): LinkResult {
  const result: LinkResult = { linked: [], failed: [] };
  for (const rel of LINK_DIRS) {
    const src = join(mainDir, rel);
    const dst = join(copyDir, rel);
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    let existing;
    try {
      existing = lstatSync(dst);
    } catch {
      existing = undefined;
    }
    if (existing) {
      if (existing.isSymbolicLink()) result.linked.push(rel);
      continue;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      result.linked.push(rel);
    } catch (error) {
      // Не смогли связать — файлы поедут копией, как раньше: автономность
      // копии важнее единого источника.
      result.failed.push({
        path: rel,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * Снять ссылки с копии перед её удалением.
 *
 * `git worktree remove` про них не знает: он видит каталог, которого нет в
 * индексе, и оставляет его на диске. Дальше копия «убрана», а `<копия>/.claude`
 * лежит — и повторное создание той же ветки умирает с `already exists`.
 *
 * Снимаем ИМЕННО ССЫЛКУ, а не содержимое: на месте назначения лежит junction на
 * каталог оригинала, и рекурсивное удаление вычистило бы настоящие скиллы
 * человека. Поэтому сначала `lstat` (он не идёт по ссылке), а удаляем через
 * `rmdir`, который у junction убирает саму точку входа. Обычный каталог —
 * значит связать не удалось и файлы приехали копией: его не трогаем, им
 * распорядится git.
 */
export function unlinkSharedDirs(copyDir: string): string[] {
  const removed: string[] = [];
  for (const rel of LINK_DIRS) {
    const dst = join(copyDir, rel);
    let info;
    try {
      info = lstatSync(dst);
    } catch {
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    try {
      rmdirSync(dst);
      removed.push(rel);
    } catch {
      try {
        unlinkSync(dst);
        removed.push(rel);
      } catch {
        // Останется на диске: удаление копии важнее, а причину человек увидит
        // на повторном создании той же ветки.
      }
    }
  }
  return removed;
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
  const [flaggedOut, ignoredOut, othersOut, modifiedOut] = await Promise.all([
    git(mainDir, ['ls-files', '-v', '-z']),
    git(mainDir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
    git(mainDir, ['ls-files', '--others', '--exclude-standard', '-z']),
    // Репозиторий без коммитов: `HEAD` нет, местных правок относительно него
    // тоже — пустой список, а не отказ всего зеркала.
    git(mainDir, ['diff', '--name-only', '-z', 'HEAD', '--']).catch(() => ''),
  ]);
  const plan = planMirror({
    flagged: parseFlagged(flaggedOut),
    ignored: parseIgnored(ignoredOut),
    others: parsePaths(othersOut),
    modified: parsePaths(modifiedOut),
    settings,
    listDir: (dir) => listFilesUnder(mainDir, dir),
  });

  const links = linkSharedDirs(mainDir, copyDir);
  const report: WorktreeMirrorReport = {
    mirrored: [],
    skipped: [
      ...links.failed,
      ...plan.built.map((path) => ({
        path,
        kind: 'build-env' as const,
        reason: 'окружение сборки — копия ставит его командой после создания',
        reasonCode: 'worktree-mirror-skip-build-env' as const,
      })),
    ],
    unlisted: plan.unlisted,
    kept: 0,
    ...(links.linked.length > 0 ? { linked: links.linked } : {}),
  };
  const copied = new Set<string>();
  const linkedPrefixes = links.linked.map((rel) => `${rel}/`);

  for (const relPath of plan.files) {
    // Под ссылкой файл уже на месте — копия туда писать не должна: это тот же
    // каталог оригинала, и «перенос» затёр бы его своей же версией.
    if (linkedPrefixes.some((prefix) => relPath.startsWith(prefix))) continue;
    const src = join(mainDir, relPath);
    const dst = join(copyDir, relPath);
    let info;
    try {
      info = lstatSync(src);
    } catch {
      report.skipped.push({
        path: relPath,
        reason: 'нет в основной копии',
        reasonCode: 'worktree-mirror-skip-absent',
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      report.skipped.push({
        path: relPath,
        reason: 'ссылка',
        reasonCode: 'worktree-mirror-skip-link',
      });
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MIRROR_SIZE_LIMIT) {
      report.skipped.push({
        path: relPath,
        reason: `больше 8 МБ (${Math.round(info.size / 1024 / 1024)} МБ)`,
        reasonCode: 'worktree-mirror-skip-too-big',
        reasonParams: { size: Math.round(info.size / 1024 / 1024) },
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
  for (const path of failed)
    report.skipped.push({
      path,
      reason: 'флаг git не поставлен',
      reasonCode: 'worktree-mirror-skip-git-flag',
    });

  return report;
}

/** Одна строка для тоста и вывода: что перенесено, что пропущено, что осталось. */
export function describeMirror(report: WorktreeMirrorReport): string {
  const parts = [serverText('worktree-mirror-moved', { count: report.mirrored.length })];
  if (report.linked && report.linked.length > 0)
    parts.push(serverText('worktree-mirror-linked', { paths: report.linked.join(', ') }));
  if (report.kept > 0) parts.push(serverText('worktree-mirror-kept', { count: report.kept }));
  if (report.skipped.length > 0)
    parts.push(serverText('worktree-mirror-skipped-count', { count: report.skipped.length }));
  if (report.unlisted.length > 0)
    parts.push(serverText('worktree-mirror-unlisted', { paths: report.unlisted.join(', ') }));
  return parts.join(', ');
}
