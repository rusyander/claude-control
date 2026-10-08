import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type {
  ProjectTestPyramid,
  ProjectTestPyramidCount,
  ProjectTestPyramidFramework,
} from '@agentdeck/contracts';
import { e2eFolderView, specFiles } from '../e2e-folder/e2e-folder.ts';
import { parseSpecFile } from '../e2e-sync/e2e-sync.ts';

/**
 * Пирамида тестов: сколько модульных и интеграционных стоит рядом с e2e.
 *
 * Правило одно — не гадать. Слой считается, только если его каркас назван
 * самим проектом: конфиг (`vitest.config.*`, `jest.config.*`, `.mocharc.*`,
 * `pytest.ini`, `conftest.py`, раздел pytest в `pyproject.toml`/`setup.cfg`/
 * `tox.ini`), зависимость в `package.json` или `go.mod`. Файл `*.test.ts` в
 * проекте без каркаса — не довод: это может быть что угодно, и ноль или число
 * на экране при таком раскладе были бы выдумкой. Поэтому «не известно» — это
 * `undefined`, а не 0.
 *
 * Тесты считаются по тексту теми же разборщиками, что и папка e2e: вызов с
 * литеральным именем — тест, имя из переменных — `dynamic` (без запуска его не
 * посчитать). Деление на модульные и интеграционные — только по меткам
 * проекта; без них один общий счёт.
 *
 * Обход дорогой (весь проект), поэтому это отдельный запрос, а не часть
 * опрашиваемого вида раздела, и у обхода есть потолок — `truncated`.
 */

/** Сколько записей каталога обойти, прежде чем остановиться. */
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 12;
/** Файл тестов больше этого не читается: сгенерированный, а не написанный. */
const MAX_FILE_BYTES = 1_000_000;

/** Каталоги, где тестов проекта не бывает: зависимости, сборка, окружения. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  'site-packages',
  'test-results',
  'playwright-report',
  'blob-report',
]);

const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JS_FILE = /\.[cm]?[jt]sx?$/;
const PY_TEST = /^(test_.+|.+_test)\.py$/;
const GO_TEST = /_test\.go$/;
const GO_FUNC = /^func\s+Test[A-Z0-9_]\w*\s*\(\s*\w+\s+\*testing\.T\s*\)/gm;

/** Признаки e2e в файле тестов вне папки e2e: такие не модульные. */
const E2E_TEXT = /@playwright\/test|from\s+['"]cypress['"]|(?<![\w$])cy\.\w+\s*\(/;

/** Метки интеграционных в пути: имя `*.integration.*`, каталог `integration`. */
const INTEGRATION_NAME = /(^|[._-])integration[._-]/i;
const INTEGRATION_DIR =
  /^(integration|integration[-_]tests?|__integration__|tests?[-_]integration)$/i;
const INTEGRATION_TEXT =
  /@pytest\.mark\.integration\b|^\/\/go:build\s+.*\bintegration\b|^\/\/\s*\+build\s+.*\bintegration\b/m;

type Family = 'js' | 'py' | 'go';

interface Walked {
  files: string[];
  truncated: boolean;
}

function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

/** Файлы проекта путями от корня; каталог e2e и скрытые каталоги пропущены. */
function walkProject(root: string, e2eDir: string | undefined): Walked {
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  // Потолок записей — общий стоп обхода; потолок глубины обрывает только свою
  // ветку: одно глубокое Java-дерево не должно обнулять соседние каталоги.
  let exhausted = false;
  const skipDir = e2eDir ? e2eDir.replace(/\/+$/, '') : undefined;

  const walk = (path: string, depth: number): void => {
    if (exhausted) return;
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let list;
    try {
      list = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list.sort((left, right) => left.name.localeCompare(right.name))) {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        truncated = true;
        exhausted = true;
        return;
      }
      const next = join(path, entry.name);
      const rel = toPosix(relative(root, next));
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP.has(entry.name) || rel === skipDir) continue;
        walk(next, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(root, 0);
  return { files, truncated };
}

function readSmall(root: string, file: string): string | undefined {
  const path = join(root, ...file.split('/'));
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function dependsOn(text: string | undefined, name: string): boolean {
  if (!text) return false;
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
      (field) => {
        const deps = json[field];
        return Boolean(deps && typeof deps === 'object' && name in deps);
      },
    );
  } catch {
    return false;
  }
}

function hasJestKey(text: string | undefined): boolean {
  if (!text) return false;
  try {
    return 'jest' in (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** Каркасы, названные файлами проекта. У каждого — первый файл, который его назвал. */
export function detectFrameworks(root: string, files: string[]): ProjectTestPyramidFramework[] {
  const found = new Map<ProjectTestPyramidFramework['name'], string>();
  const note = (name: ProjectTestPyramidFramework['name'], source: string): void => {
    if (!found.has(name)) found.set(name, source);
  };
  // Ближние к корню — первыми: конфиг корня нагляднее конфига вложенного пакета.
  const ordered = [...files].sort(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right),
  );
  for (const file of ordered) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (/^vitest\.(config|workspace)\.[cm]?[jt]s$|^vitest\.workspace\.json$/.test(name)) {
      note('vitest', file);
    } else if (/^jest\.config\.([cm]?[jt]s|json)$/.test(name)) {
      note('jest', file);
    } else if (/^\.mocharc\.(c?js|json|jsonc|ya?ml)$/.test(name)) {
      note('mocha', file);
    } else if (name === 'pytest.ini' || name === 'conftest.py') {
      note('pytest', file);
    } else if (name === 'go.mod') {
      note('go', file);
    } else if (name === 'pyproject.toml' || name === 'setup.cfg' || name === 'tox.ini') {
      const text = readSmall(root, file) ?? '';
      if (/^\[(tool\.pytest[^\]]*|tool:pytest|pytest)\]/m.test(text)) note('pytest', file);
    } else if (name === 'package.json') {
      const text = readSmall(root, file);
      if (dependsOn(text, 'vitest')) note('vitest', file);
      if (dependsOn(text, 'jest') || hasJestKey(text)) note('jest', file);
      if (dependsOn(text, 'mocha')) note('mocha', file);
    }
  }
  const order: ProjectTestPyramidFramework['name'][] = ['vitest', 'jest', 'mocha', 'pytest', 'go'];
  return order.flatMap((name) => {
    const source = found.get(name);
    return source ? [{ name, source }] : [];
  });
}

/** Файл тестов какого каркаса — или не тест вовсе (для найденных каркасов). */
function familyOf(file: string, families: Set<Family>): Family | undefined {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (families.has('js') && JS_FILE.test(name)) {
    if (JS_TEST.test(name) || file.split('/').includes('__tests__')) return 'js';
  }
  if (families.has('py') && PY_TEST.test(name)) return 'py';
  if (families.has('go') && GO_TEST.test(name)) return 'go';
  return undefined;
}

function countTests(
  file: string,
  family: Family,
  text: string,
): { tests: number; dynamic: number } {
  if (family === 'go') return { tests: text.match(GO_FUNC)?.length ?? 0, dynamic: 0 };
  const parsed = parseSpecFile(file, text);
  return { tests: parsed.tests.length, dynamic: parsed.skipped.length };
}

function isIntegration(file: string, text: string): boolean {
  const parts = file.split('/');
  const name = parts[parts.length - 1] ?? '';
  return (
    INTEGRATION_NAME.test(name) ||
    parts.slice(0, -1).some((part) => INTEGRATION_DIR.test(part)) ||
    INTEGRATION_TEXT.test(text)
  );
}

const empty = (): ProjectTestPyramidCount => ({ files: 0, tests: 0, dynamic: 0 });

function add(target: ProjectTestPyramidCount, counted: { tests: number; dynamic: number }): void {
  target.files += 1;
  target.tests += counted.tests;
  target.dynamic += counted.dynamic;
}

/** Тесты папки e2e — теми же разборщиками, что и её сверка с кейсами. */
function e2eCount(
  root: string,
  appData: string | undefined,
): ProjectTestPyramid['e2e'] | undefined {
  const folder = e2eFolderView(root, appData);
  if (folder.state === 'missing' || !folder.dir) return undefined;
  const count = { ...empty(), dir: folder.dir };
  for (const file of specFiles(root, folder.dir)) {
    const text = readSmall(root, file);
    if (text === undefined) continue;
    const parsed = parseSpecFile(file, text);
    add(count, { tests: parsed.tests.length, dynamic: parsed.skipped.length });
  }
  return count;
}

export function buildPyramid(
  root: string,
  options: { appData?: string; now?: string } = {},
): ProjectTestPyramid {
  const e2e = e2eCount(root, options.appData);
  const walked = walkProject(root, e2e?.dir);
  const frameworks = detectFrameworks(root, walked.files);

  const families = new Set<Family>();
  for (const { name } of frameworks) {
    if (name === 'pytest') families.add('py');
    else if (name === 'go') families.add('go');
    else families.add('js');
  }

  const unit = empty();
  const integration = empty();
  const code = empty();
  let marked = false;
  for (const file of walked.files) {
    const family = familyOf(file, families);
    if (!family) continue;
    const text = readSmall(root, file);
    if (text === undefined) continue;
    // Спека Playwright или Cypress вне папки e2e — всё равно e2e, не модульный.
    if (family === 'js' && E2E_TEXT.test(text)) continue;
    const counted = countTests(file, family, text);
    // В `__tests__` лежат и помощники, фикстуры, заглушки: файл без имени теста
    // и без единого теста — не тестовый, и счёт файлов он раздувал.
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (family === 'js' && !JS_TEST.test(name) && counted.tests + counted.dynamic === 0) continue;
    add(code, counted);
    if (isIntegration(file, text)) {
      marked = true;
      add(integration, counted);
    } else {
      add(unit, counted);
    }
  }

  const known = frameworks.length > 0;
  return {
    frameworks,
    split: known && marked,
    ...(known && marked ? { unit, integration } : {}),
    ...(known && !marked ? { code } : {}),
    ...(e2e ? { e2e } : {}),
    truncated: walked.truncated,
    checkedAt: options.now ?? new Date().toISOString(),
  };
}
