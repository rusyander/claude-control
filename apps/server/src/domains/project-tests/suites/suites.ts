import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';
import type { ProjectTestCase, ProjectTestGroup } from '@agentdeck/contracts';
import { readPanelJson, writePanelJson } from '../../../lib/app-store/group-sources.ts';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import { slugify } from '../../../lib/slug.ts';
import { isDir, isFile, listDir, readText, relPath } from '../../project-runner/stacks/fs-probe.ts';
import { readAutomation, writeAutomation } from '../automation/automation.ts';
import { automationRecipes, type ToolCheck } from '../automation/recipes.ts';
import { groupFile, loadForWrite, readGroups, writeGroup } from '../store/store.ts';
import { readSuiteFacts, suiteDigest, suiteText } from './describe.ts';
import type { DiscoveredSuite, SuiteStack, SuitesSync } from './suites.types.ts';

export type { DiscoveredSuite, SuiteStack, SuitesSync } from './suites.types.ts';

/**
 * Каталоги с тестами проекта — в кейсы-наборы: один кейс на каталог, а не на
 * тест. В проекте на тысячи тестовых функций кейс на функцию — шум, которого
 * никто не прочтёт; каталог — единица, которую агент правит и о которой
 * спрашивают «зелёное ли».
 *
 * Ключ набора (`automation.suite`) — то, чем отчёт прогона называет владельца
 * теста, поэтому результаты ложатся на кейс без меток в коде:
 * - Go — путь импорта пакета (`go test -json`, classname = пакет);
 * - JS/TS — каталог от корня пакета (`package.json`): так пишет classname
 *   JUnit vitest; глубже `JS_DEPTH` каталогов — сводится к предку, иначе
 *   компонентная раскладка давала бы кейс на каждый файл;
 * - pytest — модуль от корня pytest через точку; JVM — пакет через точку.
 */

const SKIP = new Set([
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  'coverage',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
  'testdata',
  '__fixtures__',
  '__snapshots__',
]);
const skipped = (name: string): boolean => name.startsWith('.') || SKIP.has(name);
/** Потолок обхода: каталогов, после которых обход честно говорит «не всё». */
const DIR_CAP = 20_000;
const MAX_DEPTH = 14;
/** JS: глубина каталога-набора от корня пакета (`src/features/Chat`). */
const JS_DEPTH = 3;

const GO_TEST = /_test\.go$/;
const JS_TEST = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const PY_TEST = /^test_.*\.py$|_test\.py$/;
const JVM_TEST = /(Test|Tests|IT)\.(java|kt)$/;
const JS_FILE = /\.[cm]?[jt]sx?$/;
const PYTEST_CONFIG = /^\[tool\.pytest|^\[tool:pytest\]|^\[pytest\]/m;

interface Walk {
  dirs: { path: string; files: string[] }[];
  truncated: boolean;
}

function walk(root: string): Walk {
  const dirs: Walk['dirs'] = [];
  let truncated = false;
  const visit = (path: string, depth: number): void => {
    if (dirs.length >= DIR_CAP) {
      truncated = true;
      return;
    }
    const files: string[] = [];
    const children: string[] = [];
    for (const name of listDir(path)) {
      const child = join(path, name);
      if (isDir(child)) {
        if (!skipped(name) && depth < MAX_DEPTH) children.push(child);
      } else files.push(name);
    }
    dirs.push({ path, files });
    for (const child of children) visit(child, depth + 1);
  };
  visit(root, 0);
  return { dirs, truncated };
}

/** Ближайший предок `dir` (включительно, не выше `root`), где лежит `marker`. */
function nearest(root: string, dir: string, has: (path: string) => boolean): string | undefined {
  let current = dir;
  for (;;) {
    if (has(current)) return current;
    if (current === root) return undefined;
    const parent = join(current, '..');
    if (parent === current || relPath(root, parent).startsWith('..')) return undefined;
    current = parent;
  }
}

/** Путь от `base` через `/`; тот же каталог — пустая строка, а не `.`. */
const under = (base: string, path: string): string => {
  const value = relPath(base, path);
  return value === '.' ? '' : value;
};

const goModule = (dir: string): string | undefined =>
  /^module\s+(\S+)/m.exec(readText(join(dir, 'go.mod')) ?? '')?.[1];

const pytestRoot = (dir: string): boolean =>
  ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some(
    (name) => isFile(join(dir, name)) && PYTEST_CONFIG.test(readText(join(dir, name)) ?? ''),
  );

/** Каталоги с тестами — наборы со своим ключом. */
export function discoverSuites(root: string): { suites: DiscoveredSuite[]; truncated: boolean } {
  const { dirs, truncated } = walk(root);
  const found = new Map<string, DiscoveredSuite>();
  const add = (path: string, key: string, stack: SuiteStack, files: string[]): void => {
    const dir = under(root, path) || '.';
    const id = `${stack}\u0000${dir}`;
    const known = found.get(id);
    if (known) {
      known.files += files.length;
      known.paths.push(...files);
    } else found.set(id, { dir, key, stack, files: files.length, paths: [...files] });
  };

  for (const { path, files } of dirs) {
    const pick = (test: RegExp): string[] =>
      files.filter((name) => test.test(name)).map((name) => under(root, join(path, name)));
    const go = pick(GO_TEST);
    if (go.length > 0) {
      const moduleDir = nearest(root, path, (at) => isFile(join(at, 'go.mod')));
      const module = moduleDir ? goModule(moduleDir) : undefined;
      if (moduleDir && module) {
        const rel = under(moduleDir, path);
        add(path, rel ? `${module}/${rel}` : module, 'go', go);
      }
    }
    const js = pick(JS_TEST);
    if (js.length > 0) {
      const pkg = nearest(root, path, (at) => isFile(join(at, 'package.json')));
      if (pkg) {
        const parts = under(pkg, path).split('/').filter(Boolean).slice(0, JS_DEPTH);
        add(join(pkg, ...parts), parts.join('/') || '.', 'js', js);
      }
    }
    const py = pick(PY_TEST);
    if (py.length > 0) {
      const base = nearest(root, path, pytestRoot) ?? root;
      const rel = under(base, path);
      add(path, rel ? rel.split('/').join('.') : '.', 'pytest', py);
    }
    const jvm = pick(JVM_TEST);
    const source = /[\\/]src[\\/]test[\\/](java|kotlin)([\\/]|$)/.exec(path);
    if (jvm.length > 0 && source) {
      const pkg = path
        .slice(source.index + source[0].length)
        .split(/[\\/]/)
        .filter(Boolean);
      add(path, pkg.join('.') || '.', 'jvm', jvm);
    }
  }
  const suites = [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const suite of suites) suite.paths.sort();
  return { suites, truncated };
}

/**
 * Что гонять у кейса-набора JS (`file` — каталог `pkg/dir/`, `pkg` — ближайший к нему
 * package.json). Набор мельче `JS_DEPTH` владеет только файлами самого каталога, а
 * фильтр-каталог vitest рекурсивен: набор корня пакета гнал весь пакет, и inst-docs-ui
 * упирался в предел 10 мин ради пяти проверок одного файла (24.10.2026). На глубине
 * `JS_DEPTH` набор собирает и потомков — тогда каталог и есть его прогон.
 */
export function jsSuiteRunPaths(root: string, pkg: string, dirFile: string): string[] {
  const dir = dirFile.replace(/\/$/, '');
  const inside = pkg ? dir.slice(pkg.length).replace(/^\//, '') : dir;
  if (inside && inside.split('/').length >= JS_DEPTH) return [dirFile];
  const own = listDir(join(root, dir))
    .filter((name) => JS_TEST.test(name) && isFile(join(root, dir, name)))
    .sort();
  return own.length > 0 ? own.map((name) => posix.join(dir, name)) : [dirFile];
}

/**
 * Ключи, под которыми владелец теста из отчёта может найти свой набор, — от
 * точного к общему. Путь (`/`): сам, потом каждый предок — файл JS ложится в
 * каталог-набор, пакет Go без своего кейса — в ближайший набор выше. Имя через
 * точку: сам, без класса, без модуля — pytest и JVM.
 */
export function suiteKeysOf(owner: string): string[] {
  const value = owner.trim().replace(/\\/g, '/');
  if (!value) return [];
  const keys = [value];
  // Файл (classname JS — путь файла теста) ложится и в набор корня пакета; путь
  // пакета Go — нет: иначе пакет без своего кейса уходил бы в чужой корневой набор.
  const isFile = JS_FILE.test(value);
  if (value.includes('/')) {
    let current = value;
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'));
      if (current) keys.push(current);
    }
    if (isFile) keys.push('.');
    return keys;
  }
  if (isFile) return [value, '.'];
  let current = value;
  for (let strip = 0; strip < 2 && current.includes('.'); strip += 1) {
    current = current.slice(0, current.lastIndexOf('.'));
    keys.push(current);
  }
  return keys;
}

/** Группа набора — по первому каталогу пути: `cp-auth/internal/x` → `suites-cp-auth`. */
function groupOf(dir: string): { id: string; title: string } {
  const top = dir === '.' ? '' : (dir.split('/')[0] ?? '');
  const slug = slugify(top, 32).replace(/^-+/, '');
  return top && /^[a-z0-9]/.test(slug)
    ? { id: `suites-${slug}`, title: `Наборы тестов: ${top}` }
    : { id: 'suites', title: 'Наборы тестов' };
}

function nextId(groupId: string, taken: Set<string>): string {
  for (let index = 1; ; index += 1) {
    const id = `${groupId}-${String(index).padStart(3, '0')}`;
    if (!taken.has(id)) return id;
  }
}

function suiteCase(root: string, suite: DiscoveredSuite, id: string, now: string): ProjectTestCase {
  const parent = posix.dirname(suite.dir);
  const text = suiteText(suite, readSuiteFacts(root, suite));
  return {
    id,
    type: 'case',
    ...text,
    ...(parent && parent !== '.' ? { section: parent } : {}),
    readiness: 'ready',
    automation: {
      status: 'automated',
      file: suite.dir === '.' ? '.' : `${suite.dir}/`,
      suite: suite.key,
      suiteDigest: suiteDigest(text),
    },
    ...(suite.dir === '.' ? {} : { codePaths: [suite.dir] }),
    status: 'unknown',
    source: 'agent',
    updatedAt: now,
  };
}

/**
 * Кейс-набор ещё в том виде, в каком его написала панель: отпечаток текста
 * совпадает с записанным при создании. Кейсы первой версии (один шаг «Прогнать
 * тесты каталога») отпечатка не имеют и узнаются по самому шаблону. Кейс,
 * который правили человек или агент, панель больше не переписывает.
 */
function untouched(item: ProjectTestCase, dir: string): boolean {
  const digest = item.automation?.suiteDigest;
  if (digest) return digest === suiteDigest(item);
  const steps = item.steps ?? [];
  return (
    steps.length === 1 &&
    steps[0]?.action === `Прогнать тесты каталога ${dir}` &&
    item.expected === 'Все тесты каталога проходят'
  );
}

/**
 * Завести недостающие кейсы-наборы. Повтор ничего не меняет: набор узнаётся
 * по ключу и стеку, а не по названию; кейс человека не трогается вовсе.
 */
export function syncSuites(root: string, now: string, dry = false): SuitesSync {
  const { suites, truncated } = discoverSuites(root);
  const groups = readGroups(root);
  const taken = new Set(groups.flatMap((group) => group.cases.map((item) => item.id)));
  const broken = new Set(groups.filter((group) => group.error).map((group) => group.id));
  const known = new Set(groups.map((group) => group.id));
  const existing = new Map<
    string,
    { groupId: string; caseId: string; dir: string; item: ProjectTestCase }
  >();
  for (const group of groups) {
    for (const item of group.cases) {
      const suite = item.automation?.suite;
      if (!suite) continue;
      const dir = (item.automation?.file ?? '').replace(/\/$/, '') || '.';
      existing.set(`${suite}\u0000${dir}`, { groupId: group.id, caseId: item.id, dir, item });
    }
  }

  const additions = new Map<string, { title: string; cases: ProjectTestCase[] }>();
  // Тексты кейсов, которые панель перепишет: тесты каталога сменились, а кейс никто не правил.
  const refreshes = new Map<string, Map<string, ProjectTestCase>>();
  const seen = new Set<string>();
  for (const suite of suites) {
    const key = `${suite.key}\u0000${suite.dir}`;
    seen.add(key);
    const prior = existing.get(key);
    if (prior) {
      if (broken.has(prior.groupId) || !untouched(prior.item, prior.dir)) continue;
      const text = suiteText(suite, readSuiteFacts(root, suite));
      const digest = suiteDigest(text);
      if (prior.item.automation?.suiteDigest === digest) continue;
      const automation = {
        ...prior.item.automation,
        status: 'automated' as const,
        suiteDigest: digest,
      };
      const fresh: ProjectTestCase = { ...prior.item, ...text, automation, updatedAt: now };
      const byGroup = refreshes.get(prior.groupId) ?? new Map<string, ProjectTestCase>();
      byGroup.set(prior.caseId, fresh);
      refreshes.set(prior.groupId, byGroup);
      continue;
    }
    const group = groupOf(suite.dir);
    if (broken.has(group.id)) continue;
    const id = nextId(group.id, taken);
    taken.add(id);
    const entry = additions.get(group.id) ?? { title: group.title, cases: [] };
    entry.cases.push(suiteCase(root, suite, id, now));
    additions.set(group.id, entry);
  }

  let refreshed = 0;
  if (!dry) {
    for (const groupId of new Set([...additions.keys(), ...refreshes.keys()])) {
      const entry = additions.get(groupId);
      const fresh = refreshes.get(groupId);
      // Перечитываем прямо перед записью: между обходом и записью мог писать агент.
      const current: ProjectTestGroup = known.has(groupId)
        ? loadForWrite(root, groupId)
        : { id: groupId, title: entry?.title ?? groupId, file: groupFile(groupId), cases: [] };
      const cases = current.cases.map((item) => {
        const next = fresh?.get(item.id);
        // Правку, пришедшую после обхода, не затираем: переписывается только нетронутый.
        if (!next || !untouched(item, (item.automation?.file ?? '').replace(/\/$/, '') || '.')) {
          return item;
        }
        refreshed += 1;
        return next;
      });
      writeGroup(root, { ...current, cases: [...cases, ...(entry?.cases ?? [])] });
    }
  } else {
    refreshed = [...refreshes.values()].reduce((sum, byGroup) => sum + byGroup.size, 0);
  }

  const missing = [...existing]
    .filter(([key, ref]) => !seen.has(key) && !isDir(join(root, ref.dir)))
    .map(([, ref]) => ref);
  return {
    suites: suites.length,
    added: [...additions.values()].reduce((sum, entry) => sum + entry.cases.length, 0),
    refreshed,
    groups: [...additions.keys()],
    missing,
    truncated,
  };
}

const STORE = 'tests-suites.json';

/**
 * Сам, без просьбы, панель пишет кейсы-наборы только в проект, где кейсов ещё
 * нет, и только туда, где git их не увидит: `.agent/tests` уже есть (проект сам
 * решил, хранить ли его), каталог спрятан от git или проекта под git нет. Иначе
 * сотни новых файлов легли бы в `git status` чужого репозитория или поверх
 * кейсов, которые там ведут сами; там наборы заводит `tests-cli suites`.
 */
function mayWriteQuietly(root: string): boolean {
  if (isDir(join(root, '.agent', 'tests'))) {
    // Набор уже ведут кейсами — каталоги поверх них сами не кладутся: там их
    // заводит человек или агент командой, а не панель при старте.
    return !readGroups(root).some((group) => group.cases.length > 0);
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '.agent/tests/suites.tests.json'], {
      cwd: root,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch (error) {
    // 1 — не спрятан; 128 — не репозиторий (писать можно), git нет — тоже.
    const status = (error as { status?: number | null }).status;
    return status !== 1;
  }
}
type SuitesStore = { projects: Record<string, { syncedAt: string }> };

/**
 * Наборы проекта — один раз на проект: при добавлении в реестр и при первом
 * старте панели после обновления. Дальше новые каталоги заводит агент (проверка
 * конца хода называет пробел) или `tests-cli suites`; обход каждого старта
 * держал бы сервер на больших репозиториях.
 */
export function syncSuitesOnce(appData: string, root: string, now: string): SuitesSync | undefined {
  const store = readPanelJson<SuitesStore>(appData, STORE, { projects: {} });
  const projects = store && typeof store.projects === 'object' ? store.projects : {};
  const key = normalizeProjectPath(root);
  if (projects[key] || !mayWriteQuietly(root)) return undefined;
  const sync = syncSuites(root, now);
  writePanelJson(appData, STORE, { projects: { ...projects, [key]: { syncedAt: now } } });
  const adopted = adoptRunCommand(root);
  return adopted ? { ...sync, adopted } : sync;
}

/**
 * Команда прогона для кейсов-наборов, если у проекта её нет: без неё «Прогнать
 * автотесты» и `tests-cli run` по наборам отказывают, и итог каталога остаётся
 * «не прогонялся». Берётся готовый рецепт, чья программа есть на машине, с
 * наибольшим числом тестов (у репозитория из многих `go.mod` — `go:*`, все
 * модули). Своя команда проекта, даже сломанная, не трогается: её писали руками.
 */
export function adoptRunCommand(
  root: string,
  dry = false,
  hasTool?: ToolCheck,
): string | undefined {
  const own = readAutomation(root);
  if (own.automation || own.error) return undefined;
  const best = automationRecipes(root, hasTool)
    .filter((recipe) => !recipe.missing)
    .sort((a, b) => b.tests - a.tests)[0];
  if (!best) return undefined;
  if (!dry) writeAutomation(root, best.automation);
  return best.id;
}
