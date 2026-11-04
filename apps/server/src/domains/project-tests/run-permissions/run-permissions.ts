import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectTestCase, ProjectTestRunMode } from '@agentdeck/contracts';
import { TESTS_DIR } from '../files.ts';

/**
 * Границы прогона: что агенту РАЗРЕШЕНО трогать, пока он гоняет тесты.
 *
 * С этапа 10 (F6) прогон идёт задачей ядра, и каждый вызов инструмента судит судья ядра. Границы
 * режима уходят ему данными (`scopeSession` → `task.created.session.scope`): правка вне масок и
 * команды, двигающие историю, — отказ судьи с записью в журнал задачи, как отказывал прежний
 * приёмник прав панели (`decidePermission`, в архиве). Задание называет те же границы словами
 * (`describeScope`), а сверка на финише (`scope-audit.ts`) ловит то, что судья правки не видит:
 * файлы, тронутые командой оболочки.
 *
 * Границы по режимам:
 * - `generate` — запись только внутрь `.agent/tests/drafts/`: генерация пишет ЧЕРНОВИК, а файлы
 *   групп меняет панель, применяя его;
 * - `run`, `explore` — запись внутрь `.agent/tests/`;
 * - `automate` — плюс файлы автотестов, НАЗВАННЫЕ кейсами (`automation.file`), и папка e2e.
 */

/** Куда прогону можно писать. */
export interface RunScope {
  root: string;
  mode: ProjectTestRunMode;
  /**
   * Каталог от корня проекта, внутрь которого разрешена запись.
   *
   * У генерации он сужен до папки черновиков: библиотеку меняет панель, а не прогон.
   */
  writeDir: string;
  /** Пути от корня проекта, которые режим `automate` дописывает к тестовым. */
  testFiles: string[];
  /**
   * Папка e2e проекта, когда генерация пишет настоящие тесты (`e2e: true`):
   * спеки ложатся туда, а кейсы — всё равно черновиком, через панель.
   */
  e2eDir?: string;
}

/** Файлы автотестов, названные самими кейсами: их и пишет режим `automate`. */
function automationFiles(cases: ProjectTestCase[]): string[] {
  const files = cases
    .map((item) => item.automation?.file?.trim())
    .filter((file): file is string => Boolean(file));
  return [...new Set(files)];
}

/** Папка черновиков — единственное, куда пишет генерация. */
const DRAFTS_WRITE_DIR = `${TESTS_DIR}/drafts`;

/** Границы прогона по режиму. */
export function runScope(
  root: string,
  mode: ProjectTestRunMode,
  cases: ProjectTestCase[] = [],
  e2eDir?: string,
): RunScope {
  return {
    root,
    mode,
    writeDir: mode === 'generate' ? DRAFTS_WRITE_DIR : TESTS_DIR,
    testFiles: mode === 'automate' ? automationFiles(cases) : [],
    // Автоматизация пишет спеки туда же, куда генерация с кодом: кейс без
    // `automation.file` иначе не получил бы первого файла никогда.
    ...((mode === 'generate' || mode === 'automate') && e2eDir ? { e2eDir } : {}),
  };
}

/** Лежит ли путь внутри каталога (сам каталог считается своим). */
function inside(root: string, target: string, folder: string): boolean {
  const base = resolve(root, folder);
  const step = relative(base, target);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

function isBelowRoot(root: string, folder: string): boolean {
  const step = relative(resolve(root), resolve(root, folder));
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}

/**
 * Разрешено ли писать в этот путь. Каталог тестов — всегда; в режиме
 * `automate` ещё и файлы автотестов, которые назвали сами кейсы (и папки, в
 * которых те лежат: тесту нужен сосед-фикстура).
 */
export function isWritable(scope: RunScope, target: string): boolean {
  const path = isAbsolute(target) ? resolve(target) : resolve(scope.root, target);
  if (inside(scope.root, path, scope.writeDir || TESTS_DIR)) return true;
  // Папка e2e пришла из конфига репозитория: корень проекта или путь наружу
  // областью записи не становятся, даже если такая папка просочилась в выбор.
  if (
    scope.e2eDir &&
    isBelowRoot(scope.root, scope.e2eDir) &&
    inside(scope.root, path, scope.e2eDir)
  ) {
    return true;
  }
  if (scope.mode !== 'automate') return false;
  return scope.testFiles.some((file) => {
    const named = resolve(scope.root, file);
    if (path === named) return true;
    // Папка названного теста: рядом с ним живут фикстуры и вспомогательные файлы.
    const folder = named.slice(0, named.lastIndexOf(sep) + 1);
    return folder.length > 1 && path.startsWith(folder);
  });
}

/** Границы словами — этот текст уходит в задание прогона (`runs.ts`). */
export function describeScope(scope: RunScope): string {
  const base = `writing is allowed only inside ${scope.writeDir || TESTS_DIR}/`;
  if (scope.mode === 'generate') {
    const e2e = scope.e2eDir ? ` and into the e2e folder ${scope.e2eDir}/ (test code)` : '';
    return `${base}${e2e} — the panel changes the library by applying the draft`;
  }
  if (scope.mode !== 'automate') return base;
  const folder = scope.e2eDir ? `, into the e2e folder ${scope.e2eDir}/ (test code)` : '';
  const named = scope.testFiles.length
    ? `, and also into the autotest files the cases name (${scope.testFiles.slice(0, 5).join(', ')}${
        scope.testFiles.length > 5 ? ', …' : ''
      })`
    : scope.e2eDir
      ? ''
      : // Обещать «рядом с тестами проекта» нельзя: сверка на финише такую запись отметит.
        ' — the project has no e2e folder, so no test code can be written: leave automation.status at toAutomate and say why in note';
  return `${base}${folder}${named}`;
}

/**
 * Команды, меняющие репозиторий, — префиксы argv для судьи ядра: тот же список, что был у
 * прежнего приёмника прав (`FORBIDDEN_COMMANDS`). Прогон описывает состояние приложения, а не
 * двигает историю.
 */
export const RUN_DENY_COMMANDS: readonly (readonly string[])[] = [
  'commit',
  'push',
  'reset',
  'checkout',
  'switch',
  'clean',
  'rebase',
  'merge',
  'cherry-pick',
  'tag',
  'stash',
  'worktree',
].map((verb) => ['git', verb]);

/** Путь от корня проекта косыми чертами; вне корня — `undefined` (маской не станет). */
function rootedOf(root: string, target: string): string | undefined {
  const step = relative(resolve(root), resolve(root, target));
  if (!step || step.startsWith('..') || isAbsolute(step)) return undefined;
  return step.split(sep).join('/');
}

/**
 * Границы прогона маской от корня для судьи ядра (`session.scope.edit`) — то же множество, что
 * `isWritable`: каталог записи режима, папка e2e (только ниже корня), в `automate` — названные
 * кейсами файлы и папки, где они лежат.
 */
export function scopeSession(scope: RunScope): {
  edit: string[];
  denyCommands: string[][];
} {
  const dirs = [scope.writeDir || TESTS_DIR];
  if (scope.e2eDir && isBelowRoot(scope.root, scope.e2eDir)) dirs.push(scope.e2eDir);
  const edit = dirs.flatMap((dir) => {
    const rooted = rootedOf(scope.root, dir);
    return rooted ? [rooted, `${rooted}/**`] : [];
  });
  if (scope.mode === 'automate') {
    for (const file of scope.testFiles) {
      const rooted = rootedOf(scope.root, file);
      if (!rooted) continue;
      edit.push(rooted);
      const folder = rooted.includes('/') ? rooted.slice(0, rooted.lastIndexOf('/')) : '';
      if (folder) edit.push(`${folder}/**`);
    }
  }
  return {
    // Потолок схемы ядра — 64 маски: каталог записи идёт первым и не отрезается никогда.
    edit: [...new Set(edit)].slice(0, 64),
    denyCommands: RUN_DENY_COMMANDS.map((prefix) => [...prefix]),
  };
}

/** Строка границ для задания: модель держит правило, о котором знает. */
export function scopeClause(scope: RunScope): string {
  return (
    `Write scope of this run: ${describeScope(scope)}. ` +
    'Never commit, reset or switch branches. The panel compares the working tree after the run ' +
    'and reports every file changed outside this scope.'
  );
}
