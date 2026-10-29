import type { RepoPath } from '@agentdeck/contracts/core/records';
import type { FlaggedEntry, MirrorInput, MirrorPlan, MirrorSettings } from './copy.types.ts';

/**
 * Что из локального слоя основной копии переносится в копию (перенесено из панели,
 * `project-git/mirror-local.ts`; 04:97). `git worktree add` выкладывает чистый чекаут: всего,
 * чего git не хранит (`.mcp.json` со `skip-worktree`, `.agent/**`, `.env*`, слой CLI проекта),
 * в копии нет, и первый ход агента был бы «настройкой worktree».
 *
 * ЧЕТЫРЕ источника, каждый закрывает свою дыру: флаги `skip-worktree`/`assume-unchanged`;
 * игнорируемое по списку; неотслеживаемое и не игнорируемое по тому же списку; отслеживаемое с
 * местной правкой по списку (в чекауте лежала бы версия коммита). Последние два берут только
 * названное в списке — иначе зеркало тащило бы в копию всю незакоммиченную работу.
 *
 * Здесь только правила — списки от git и обход каталогов приходят снаружи (`platform/copy-git`,
 * `platform/copy-fs`), поэтому правила проверяются без репозитория.
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
  // Проектный слой остальных CLI: у копии он такой же, как у оригинала, иначе агент чужого CLI
  // в копии остаётся без своих переходников и правил. Это данные списка, а не ветвление по CLI.
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
  // Сборка локального слоя несёт абсолютные пути оригинала; копия собирает свою.
  '.agent/local-layer/build/**',
];

/**
 * Каталоги, внутрь которых зеркало не заходит никогда, где бы они ни лежали: всё это — результат
 * сборки или установки (абсолютные пути оригинала внутри `.venv`/`.gradle`, бинарники платформы,
 * гигабайты под пределом длины пути). Закрыто ДО шаблонов человека: широкий шаблон иначе утащил
 * бы `node_modules`, а копия всё равно не заработала бы. Их ставит установка (`install-plan.ts`).
 */
export const NEVER_DIRS: ReadonlySet<string> = new Set([
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

/**
 * Шаблон в регулярное выражение по правилам `.gitignore`, которых хватает человеку: `**` — любая
 * глубина (и ноль сегментов), `*` — внутри сегмента, `?` — один символ.
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

type Matcher = (path: RepoPath) => boolean;

function matcherFor(pattern: string): Matcher | undefined {
  const clean = pattern.trim();
  if (!clean || clean.startsWith('#')) return undefined;
  const regExp = globToRegExp(clean);
  // Шаблон без «/» сравнивается с именем на любой глубине, с «/» — с путём от корня.
  const byName = !clean.replace(/\/+$/, '').includes('/');
  return byName
    ? (path) => regExp.test(path.slice(path.lastIndexOf('/') + 1))
    : (path) => regExp.test(path);
}

function matchers(patterns: readonly string[]): Matcher[] {
  return patterns.map(matcherFor).filter((m): m is Matcher => m !== undefined);
}

/** Относительный путь с прямыми слэшами — так его называет git и так его сравниваем. */
export function normalizeRel(path: string): RepoPath {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function isNever(path: string): boolean {
  const rel = normalizeRel(path);
  if (rel.split('/').some((segment) => NEVER_DIRS.has(segment))) return true;
  return matchers(NEVER_FILES).some((m) => m(rel));
}

export function effectiveSettings(user: MirrorSettings | undefined): MirrorSettings {
  return {
    include: [...DEFAULT_INCLUDE, ...(user?.include ?? [])],
    exclude: [...DEFAULT_EXCLUDE, ...(user?.exclude ?? [])],
  };
}

export function listed(path: string, include: readonly string[]): boolean {
  const rel = normalizeRel(path);
  return matchers(include).some((m) => m(rel));
}

/** Под зеркало: есть в списке, не вычтен, не запретный. */
export function wanted(path: string, settings: MirrorSettings): boolean {
  const rel = normalizeRel(path);
  if (isNever(rel) || !listed(rel, settings.include)) return false;
  return !matchers(settings.exclude).some((m) => m(rel));
}

/**
 * Может ли шаблон с «/» найти что-то ВНУТРИ свёрнутого игнорируемого каталога. Шаблоны по имени
 * сюда не считаются: ради `*.local` обходить каждый каталог значило бы обходить всё.
 */
export function includeReaches(dir: string, include: readonly string[]): boolean {
  const head = normalizeRel(dir).split('/')[0] as string;
  return include.some((pattern) => {
    const clean = pattern.trim().replace(/^\.?\//, '');
    if (!clean.replace(/\/+$/, '').includes('/')) return false;
    if (clean.startsWith('**/')) return true;
    const first = clean.split('/')[0] as string;
    return first === head || globToRegExp(first).test(head);
  });
}

/** `git ls-files -v -z`: `S`/`s` — skip-worktree, `h` — assume-unchanged. */
export function parseFlagged(stdout: string): FlaggedEntry[] {
  const out: FlaggedEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 3) continue;
    const tag = record[0] as string;
    const path = record.slice(2);
    if (tag === 'S' || tag === 's') out.push({ path, flag: 'skip-worktree' });
    else if (tag === 'h') out.push({ path, flag: 'assume-unchanged' });
  }
  return out;
}

/** Списки путей `-z` от git. */
export function parsePaths(stdout: string): string[] {
  return stdout.split('\0').filter((item) => item.length > 0);
}

export function planMirror(input: MirrorInput): MirrorPlan {
  const settings = effectiveSettings(input.settings);
  const files = new Set<RepoPath>();
  const unlisted: RepoPath[] = [];
  const built: RepoPath[] = [];

  for (const entry of input.flagged) {
    if (!isNever(entry.path)) files.add(normalizeRel(entry.path));
  }

  for (const raw of input.ignored) {
    const isDir = raw.endsWith('/');
    const path = normalizeRel(raw);
    const topLevel = !path.includes('/');
    if (isNever(path)) {
      // Каталог окружения сборки молча пропасть не может: человек ищет свой `.venv` в копии и
      // должен прочесть, что его ставит установка. Логи — нет: их отсутствие никого не удивит.
      if (topLevel && isDir) built.push(`${path}/`);
      continue;
    }
    if (isDir) {
      if (includeReaches(path, settings.include)) {
        for (const file of input.listDir(path)) {
          if (wanted(file, settings)) files.add(normalizeRel(file));
        }
      } else {
        // Вложенный тоже называется (04:98): git свернул его целиком, и `.env.local` внутри
        // `apps/web/.vercel/` иначе пропал бы молча — обходить каждый такой каталог ради
        // шаблонов по имени зеркало не берётся.
        unlisted.push(`${path}/`);
      }
      continue;
    }
    if (wanted(path, settings)) files.add(path);
    // Вычтенное человеком «за бортом» не называется: он это уже решил.
    else if (topLevel && !listed(path, settings.include)) unlisted.push(path);
  }

  // Третий и четвёртый источники — только названное в списке: незакоммиченная работа не наше дело.
  for (const raw of [...input.others, ...input.modified]) {
    const path = normalizeRel(raw);
    if (path && wanted(path, settings)) files.add(path);
  }

  return {
    files: [...files].sort(),
    flagged: input.flagged.filter((entry) => files.has(normalizeRel(entry.path))),
    unlisted: unlisted.sort(),
    built: built.sort(),
  };
}
