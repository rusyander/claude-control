import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectTestE2eFolder, ProjectTestE2eFramework } from '@agentdeck/contracts';
import { readJsonFile, removeEntry, writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import { spelledOnDisk } from '../../../lib/disk-spelling/disk-spelling.ts';
import { StatMemo } from '../../../lib/stat-memo/stat-memo.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { gitSync } from '../../project-git/exec/exec.ts';
import { ProjectTestsError, ProjectTestsNotFoundError } from '../files.ts';
import { E2E_SCAFFOLD, PANEL_E2E_DIR } from '../e2e-scaffold.ts';

/**
 * Папка e2e проекта: найти, завести, убрать.
 *
 * Правило владельца: папка, которая в проекте уже есть, берётся КАК ЕСТЬ —
 * панель в ней ничего не создаёт и не прячет, агент пишет в неё в стиле
 * соседних тестов. Нет папки — панель заводит `e2e/` со своей заготовкой и
 * прячет её от git строкой в `.git/info/exclude` (не в `.gitignore`: тот
 * коммитится, и решение одного человека уехало бы всей команде).
 *
 * Главное свойство заведённой папки то же, что у переопределения групп
 * (`groups/override.ts`): УБРАННАЯ, она возвращает проект байт в байт. Поэтому
 * запись хранит байты файла исключений ДО панели и каталоги, которых не было, —
 * и лежит в каталоге данных панели, а не в проекте: это факт об ЭТОЙ машине.
 */

/** Конфиги, по которым папка e2e известна точно. */
const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];
const CYPRESS_CONFIGS = ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs'];

/** Обычные имена папки e2e — от самого частого к редкому. */
const CANDIDATES = [
  'e2e',
  'tests/e2e',
  'test/e2e',
  'e2e-tests',
  'tests-e2e',
  'playwright',
  'tests/playwright',
  'cypress/e2e',
  'cypress/integration',
];

/** Где в монорепозитории лежат приложения: `apps/*`, `packages/*` и одиночные каталоги. */
const NESTED_PARENTS = ['apps', 'packages'];
const NESTED_SINGLE = ['frontend', 'web', 'client'];

/**
 * Файл теста: `auth.spec.ts`, `login.test.js`, `cart.cy.ts`, `flow.e2e.ts` — и
 * модули pytest `test_cart.py` / `cart_test.py`.
 */
export const SPEC_FILE =
  /\.(spec|test|e2e|cy)\.(m?[jt]sx?|c[jt]s)$|^test_[\w-]+\.py$|^[\w-]+_test\.py$/;

/** Каталоги, в которых тестов не бывает — только их результаты и зависимости. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'results',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  'dist',
  'build',
]);

/**
 * Каталоги, которые раннеры пишут прямо в папке тестов во время прогона. Одно
 * множество на наблюдателя и на проверку «менялась ли папка»: иначе наблюдатель
 * их молчал, а проверка считала их время — и любой прогон будил лишнюю сверку.
 */
export const RUNNER_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  'test-results',
  'playwright-report',
  'blob-report',
  '__pycache__',
  'cypress-results',
  'screenshots',
  'videos',
  'downloads',
]);

const RECORD_FILE = 'tests-e2e.json';
const EXCLUDE_MARKER = '# agentdeck:e2e';
/** Потолок обхода: папка e2e с десятком тысяч файлов — уже не папка тестов. */
const MAX_SPECS = 2000;
const MAX_DEPTH = 8;

/**
 * Вид папки строится на КАЖДЫЙ запрос вида раздела (карточка опрашивает его раз
 * в пару секунд, пока идёт прогон): обход спек, конфиги монорепозитория и два
 * запуска git — синхронно, в цикле событий сервера. Замер на дереве 400 спек и
 * 12 приложений — 80 мс на вызов, 2000 спек — 107 мс, из них git — 45–60 мс.
 * Поэтому вид запоминается по подписи диска (`StatMemo`): обход сам отмечает
 * всё, на что смотрел, и повтор сверяет только время этих путей. Срок — страховка
 * от того, чего подпись не видит (репозиторий, заведённый уровнем выше).
 */
const VIEW_TTL_MS = 30_000;
const views = new StatMemo<ProjectTestE2eFolder>({ ttlMs: VIEW_TTL_MS });

/** Отметчик путей идущего построения вида; вне его — ничего не делает. */
let recorder: ((path: string) => void) | undefined;

function touch(path: string): void {
  recorder?.(path);
}

/** Что панель положила в проект, заводя папку, и как это снять байт в байт. */
export interface E2eRecord {
  projectPath: string;
  /** Папка от корня проекта. */
  dir: string;
  /** Каталоги, которых до панели не было, — снимаются, если опустели. */
  createdDirs: string[];
  /** Файлы заготовки и их байты: изменённый человеком файл — уже не наш. */
  files: { path: string; written: string }[];
  exclude?: {
    file: string;
    line: string;
    original: string | null;
    written: string;
    createdDirs: string[];
  };
  createdAt: string;
}

interface RecordState {
  version: number;
  folders: Record<string, E2eRecord>;
  /**
   * Папка, которую человек выбрал сам, — по проекту. Нужна монорепозиторию: папок
   * e2e там несколько, а первая найденная — не обязательно та, что ему нужна.
   */
  picks?: Record<string, string>;
}

/**
 * Ключ записи — путь в написании на диске. По «как ввели» запись, заведённая при
 * добавлении проекта коротким именем 8.3, не находилась маршрутами «Тестов»,
 * которые приводят путь к написанию на диске: своя папка показывалась чужой.
 */
function diskKey(path: string): string {
  return normalizeProjectPath(spelledOnDisk(resolve(path)));
}

/**
 * Записи под ключами в написании на диске. Сделанные раньше под «как ввели»
 * переключаются при чтении; ключ, уже записанный в написании на диске, главнее.
 */
function byDiskKey<T>(entries: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  const moved: [string, T][] = [];
  for (const [key, value] of Object.entries(entries)) {
    const canonical = diskKey(key);
    if (canonical === key) out[key] = value;
    else moved.push([canonical, value]);
  }
  for (const [key, value] of moved) if (!(key in out)) out[key] = value;
  return out;
}

function readRecords(appData: string): RecordState {
  touch(join(appData, RECORD_FILE));
  const state = readJsonFile<RecordState>(join(appData, RECORD_FILE), { version: 1, folders: {} });
  if (!state || typeof state.folders !== 'object') return { version: 1, folders: {} };
  return {
    ...state,
    folders: byDiskKey(state.folders),
    ...(state.picks ? { picks: byDiskKey(state.picks) } : {}),
  };
}

function writeRecords(appData: string, state: RecordState): void {
  mkdirSync(appData, { recursive: true });
  writeJsonFile(join(appData, RECORD_FILE), state);
  // Своя запись (заведение, уборка, выбор папки) — вид перечитывается сразу, не
  // полагаясь на то, что время файла успело сдвинуться.
  views.forget();
}

export function e2eRecordOf(appData: string | undefined, root: string): E2eRecord | undefined {
  if (!appData) return undefined;
  return readRecords(appData).folders[diskKey(root)];
}

/** Выбранная человеком папка проекта, если он выбирал. */
function pickOf(appData: string | undefined, root: string): string | undefined {
  if (!appData) return undefined;
  return readRecords(appData).picks?.[diskKey(root)];
}

/**
 * Выбрать папку e2e проекта самому. Только из найденных панелью: путь со стороны
 * не принимается — выбор решает, чьи файлы сверка разбирает и чью команду
 * запускает прогон. Выбор хранится в каталоге данных панели, проект не трогается.
 */
export function chooseE2eFolder(appData: string, root: string, dir: string): void {
  const wanted = posix(dir).replace(/\/+$/, '');
  if (!scanProject(root).some((item) => item.dir === wanted)) {
    throw coded(
      new ProjectTestsError(`Папки «${wanted}» среди папок e2e проекта нет.`),
      'e2e-dir-unknown',
      { dir: wanted },
    );
  }
  const state = readRecords(appData);
  writeRecords(appData, {
    ...state,
    picks: { ...state.picks, [diskKey(root)]: wanted },
  });
}

function isDir(path: string): boolean {
  // Появится или пропадёт каталог — сдвинется время его родителя.
  touch(dirname(path));
  touch(path);
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const posix = (path: string): string => path.split('\\').join('/');

/** `testDir` из конфига Playwright — разбором текста: исполнять чужой конфиг панель не станет. */
function configTestDir(base: string, file: string): string | undefined {
  touch(join(base, file));
  try {
    const text = readFileSync(join(base, file), 'utf8');
    return text.match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * `testDir` приходит из конфига репозитория, а папка e2e становится областью
 * записи агента тестов. Годится только папка строго внутри проекта и ниже
 * каталога конфига: `.` открыл бы запись в код приложения, `..` — за проект.
 */
function isTestsOnly(root: string, configDir: string, dir: string): boolean {
  const fromRoot = relative(resolve(root), dir);
  const fromConfig = relative(configDir, dir);
  const below = (step: string): boolean =>
    step !== '' && !step.startsWith('..') && !isAbsolute(step);
  return below(fromRoot) && below(fromConfig);
}

interface Found {
  dir: string;
  origin: 'config' | 'folder';
  framework: ProjectTestE2eFramework;
}

/** Кандидаты в одном каталоге (корень или приложение монорепозитория). */
function scanBase(root: string, base: string): Found[] {
  const found: Found[] = [];
  const at = join(root, base);
  // Конфиги ищутся по имени в этом каталоге: новый или убранный — его время.
  touch(at);
  const rel = (path: string): string => posix(relative(root, resolve(at, path)));
  for (const config of PLAYWRIGHT_CONFIGS) {
    if (!existsSync(join(at, config))) continue;
    const testDir = configTestDir(at, config);
    if (testDir && isDir(resolve(at, testDir)) && isTestsOnly(root, at, resolve(at, testDir))) {
      found.push({ dir: rel(testDir), origin: 'config', framework: 'playwright' });
    }
  }
  const cypress = CYPRESS_CONFIGS.some((config) => existsSync(join(at, config)));
  for (const candidate of CANDIDATES) {
    if (!isDir(join(at, candidate))) continue;
    const framework: ProjectTestE2eFramework = candidate.startsWith('cypress')
      ? 'cypress'
      : cypress
        ? 'cypress'
        : 'unknown';
    found.push({ dir: rel(candidate), origin: 'folder', framework });
  }
  return found;
}

/** Все подходящие папки проекта, первая — выбранная. */
function scanProject(root: string): Found[] {
  const bases = ['.'];
  touch(root);
  for (const parent of NESTED_PARENTS) {
    touch(join(root, parent));
    try {
      for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) bases.push(`${parent}/${entry.name}`);
      }
    } catch {
      // Нет такого каталога — не монорепозиторий этого вида.
    }
  }
  bases.push(...NESTED_SINGLE.filter((name) => isDir(join(root, name))));
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const base of bases) {
    for (const item of scanBase(root, base)) {
      if (seen.has(item.dir)) continue;
      seen.add(item.dir);
      found.push(item);
    }
  }
  return found;
}

/** Файлы тестов папки — путями от корня проекта, по алфавиту. */
export function specFiles(root: string, dir: string, limit = MAX_SPECS): string[] {
  const files: string[] = [];
  const walk = (path: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= limit) return;
    touch(path);
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      const next = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(next, depth + 1);
      } else if (SPEC_FILE.test(entry.name)) {
        files.push(posix(relative(root, next)));
      }
    }
  };
  walk(join(root, dir), 0);
  return files;
}

/** Каркас по содержимому, когда конфиг промолчал: первые файлы тестов говорят сами. */
function sniffFramework(root: string, dir: string, files: string[]): ProjectTestE2eFramework {
  for (const file of files.slice(0, 20)) {
    // Каркас читается по содержимому: правка файла без смены имён — тоже повод.
    touch(join(root, file));
    try {
      const text = readFileSync(join(root, file), 'utf8');
      if (text.includes('@playwright/test')) return 'playwright';
      if (/\bcy\.\w+\(/.test(text)) return 'cypress';
      if (file.endsWith('.py')) return 'pytest';
    } catch {
      // Нечитаемый файл — смотрим следующий.
    }
  }
  // Конфиг в самой папке (заготовка панели) или в корне: у пустой папки — до
  // первой спеки — других примет нет, а генерации нужна команда прогона уже тогда.
  return PLAYWRIGHT_CONFIGS.some(
    (config) => existsSync(join(root, dir, config)) || existsSync(join(root, config)),
  )
    ? 'playwright'
    : 'unknown';
}

/** Файл исключений git и путь проекта внутри репозитория. Не под git — `undefined`. */
function gitPlaces(root: string): { file: string; prefix: string } | undefined {
  const out = gitSync(root, ['rev-parse', '--git-path', 'info/exclude'])?.trim();
  if (!out) return undefined;
  const prefix = gitSync(root, ['rev-parse', '--show-prefix'])?.trim() ?? '';
  return { file: isAbsolute(out) ? out : resolve(root, out), prefix: posix(prefix) };
}

/** Папка e2e проекта, как её показывает раздел «Тесты». */
export function e2eFolderView(root: string, appData?: string): ProjectTestE2eFolder {
  return views.get(`${diskKey(root)}\n${appData ?? ''}`, (mark) => {
    const outer = recorder;
    recorder = mark;
    try {
      return buildFolderView(root, appData);
    } finally {
      recorder = outer;
    }
  });
}

function buildFolderView(root: string, appData?: string): ProjectTestE2eFolder {
  const record = e2eRecordOf(appData, root);
  const found = scanProject(root);
  const git = gitPlaces(root) !== undefined;
  const pick = pickOf(appData, root);
  const picked = pick ? found.find((item) => item.dir === pick) : undefined;
  const chosen =
    picked ??
    (record && isDir(join(root, record.dir))
      ? { dir: record.dir, origin: 'panel' as const, framework: 'playwright' as const }
      : found[0]);
  if (!chosen) return { state: 'missing', framework: 'unknown', specs: 0, excluded: false, git };
  const files = specFiles(root, chosen.dir);
  const framework =
    chosen.framework === 'unknown' ? sniffFramework(root, chosen.dir, files) : chosen.framework;
  const others = found.map((item) => item.dir).filter((dir) => dir !== chosen.dir);
  return {
    state: chosen.origin === 'panel' ? 'created' : 'found',
    dir: chosen.dir,
    origin: chosen.origin,
    framework,
    specs: files.length,
    excluded: chosen.origin === 'panel' && record?.exclude !== undefined,
    git,
    ...(others.length > 0 ? { candidates: others } : {}),
  };
}

/** Каталоги пути, которых ещё нет, — от внешнего к внутреннему. */
function missingDirs(dir: string, stop: string): string[] {
  const missing: string[] = [];
  for (let current = dir; current !== stop && !existsSync(current); current = dirname(current)) {
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  return missing;
}

function readBytes(file: string): string | null {
  // Ссылка на каталог в папке — не файл заготовки: чтение её дало бы EISDIR и
  // 500 при уборке вместо 409 «чужие файлы».
  try {
    return lstatSync(file).isFile() ? readFileSync(file, 'latin1') : null;
  } catch {
    return null;
  }
}

/**
 * Завести папку e2e, если её нет. Найденная папка остаётся как есть — ответ
 * тот же вид, без единой записи в проект.
 */
export function createE2eFolder(
  appData: string,
  typedRoot: string,
  now: string,
): ProjectTestE2eFolder {
  // Пути в записи — в написании на диске: по ним уборка узнаёт свои файлы.
  const root = spelledOnDisk(resolve(typedRoot));
  const current = e2eFolderView(root, appData);
  if (current.state !== 'missing') return current;
  // Запись о папке — единственный путь её убрать. Каталог данных недоступен —
  // отказ ДО первой записи в проект: папка без записи не убралась бы никогда.
  mkdirSync(appData, { recursive: true });

  const target = join(root, PANEL_E2E_DIR);
  if (existsSync(target) && !isDir(target)) {
    throw coded(
      new ProjectTestsError(`«${PANEL_E2E_DIR}» в проекте уже занят файлом.`),
      'e2e-path-taken',
      { dir: PANEL_E2E_DIR },
    );
  }
  const createdDirs = missingDirs(target, root);
  mkdirSync(target, { recursive: true });
  const files: E2eRecord['files'] = [];
  for (const [name, content] of Object.entries(E2E_SCAFFOLD)) {
    const path = join(target, name);
    // Чужой файл с тем же именем не перезаписываем: он уже не заготовка.
    if (existsSync(path)) continue;
    writeFileSync(path, content, 'utf8');
    files.push({ path, written: readBytes(path) ?? '' });
  }

  let exclude: E2eRecord['exclude'];
  const places = gitPlaces(root);
  if (places) {
    // Без «/» в конце: шаблон с ним ловит только каталог, а в копии ветки папка
    // лежит ССЫЛКОЙ на оригинал (`mirror-local.ts`) — и git копии увидел бы её
    // неотслеживаемой, агент копии закоммитил бы ссылку.
    const line = `/${places.prefix}${PANEL_E2E_DIR}`;
    const original = readBytes(places.file);
    const base = original ?? '';
    const glue = base === '' || base.endsWith('\n') ? '' : '\n';
    const written = `${base}${glue}${EXCLUDE_MARKER}\n${line}\n`;
    const dirs = missingDirs(dirname(places.file), root);
    mkdirSync(dirname(places.file), { recursive: true });
    writeFileSync(places.file, written, 'latin1');
    exclude = { file: places.file, line, original, written, createdDirs: dirs };
  }

  const state = readRecords(appData);
  state.folders[diskKey(root)] = {
    projectPath: root,
    dir: PANEL_E2E_DIR,
    createdDirs,
    files,
    ...(exclude ? { exclude } : {}),
    createdAt: now,
  };
  writeRecords(appData, state);
  return e2eFolderView(root, appData);
}

/** Файлы установки зависимостей в корне заготовки: их пишет `npm install`, не человек. */
const GENERATED_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/**
 * Файлы, похожие на чью-то работу: без выводимого — зависимостей, отчётов,
 * сборки (`SKIP_DIRS`) и замков установки. Иначе `npm install` в заготовке
 * выдавал себя за «191 чужой файл» при двух настоящих тестах, и отказ 409 пугал
 * числом, за которым нет ничьей работы.
 */
function workFiles(dir: string): string[] {
  const walk = (path: string, top: boolean): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const next = join(path, entry.name);
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(next, false);
      return top && GENERATED_FILES.has(entry.name) ? [] : [next];
    });
  return isDir(dir) ? walk(dir, true) : [];
}

/** Снять пустые каталоги, заведённые панелью, — от внутреннего к внешнему. */
function removeCreatedDirs(dirs: readonly string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Каталог занят чужим файлом — остаётся: это уже не наш каталог.
    }
  }
}

/**
 * Убрать заведённую панелью папку: проект — байт в байт как до неё.
 *
 * Файлы, которых панель не писала (тесты агента, правки человека), без `force`
 * не удаляются: это чья-то работа, и 409 называет, сколько её. Кейсы в
 * `.agent/tests/` остаются — их описание тоже работа, а привязка к удалённому
 * файлу видна в карточке кейса.
 */
export function removeE2eFolder(
  appData: string,
  root: string,
  force: boolean,
): ProjectTestE2eFolder {
  const key = diskKey(root);
  const state = readRecords(appData);
  const record = state.folders[key];
  if (!record) {
    throw coded(
      new ProjectTestsNotFoundError('Эту папку e2e завела не панель.'),
      'e2e-not-created',
    );
  }
  const target = join(root, record.dir);
  // Сравнение по написанию на диске: запись могла быть сделана коротким именем.
  const own = new Map(record.files.map((file) => [diskKey(file.path), file.written]));
  const foreign = workFiles(target).filter((file) => own.get(diskKey(file)) !== readBytes(file));
  if (foreign.length > 0 && !force) {
    const error = coded(
      new ProjectTestsError(`В папке e2e лежат чужие файлы (${foreign.length}).`),
      'e2e-folder-not-empty',
      { count: foreign.length },
    );
    error.statusCode = 409;
    throw error;
  }
  // Поштучно, а не `rmSync` рекурсивно: на Windows он врёт об успехе на
  // нелатинских путях (`lib/safe-io/fs-entry.ts`).
  removeEntry(target);

  if (record.exclude) {
    const now = readBytes(record.exclude.file);
    if (now === record.exclude.written) {
      if (record.exclude.original === null) rmSync(record.exclude.file, { force: true });
      else writeFileSync(record.exclude.file, record.exclude.original, 'latin1');
    } else if (now !== null) {
      // Файл правили после нас — снимаем ровно свою пару «маркер + строка»;
      // такая же строка человека, бывшая до панели или дописанная им, остаётся.
      const lines = now.split('\n');
      const bare = (index: number) => (lines[index] ?? '').replace(/\r$/, '');
      const at = lines.findIndex(
        (_line, index) =>
          bare(index) === EXCLUDE_MARKER && bare(index + 1) === record.exclude!.line,
      );
      if (at >= 0) {
        lines.splice(at, 2);
        writeFileSync(record.exclude.file, lines.join('\n'), 'latin1');
      }
    }
    removeCreatedDirs(record.exclude.createdDirs);
  }
  removeCreatedDirs(record.createdDirs);

  delete state.folders[key];
  writeRecords(appData, state);
  return e2eFolderView(root, appData);
}

/** Папка для записи: найденная или заведённая; нет ни той, ни другой — `undefined`. */
export function e2eDirOf(root: string, appData?: string): string | undefined {
  return e2eFolderView(root, appData).dir;
}

/** Первая строка конфига заготовки: по ней папку панели узнают без записи в каталоге данных. */
const SCAFFOLD_MARK = '// Created by AgentDeck (Tests section).';

/**
 * Папка e2e в `dir` — заготовка панели (по конфигу, который панель написала).
 * Нужна тем, у кого нет каталога данных панели: зеркалу копии ветки.
 */
export function isPanelScaffold(dir: string): boolean {
  try {
    return readFileSync(join(dir, 'playwright.config.ts'), 'utf8').includes(SCAFFOLD_MARK);
  } catch {
    return false;
  }
}

/**
 * Копия ветки видит папку оригинала ссылкой: тогда тесты и кейсы — у ОРИГИНАЛА,
 * и сверять надо его. Возвращает корень оригинала или `undefined`, если папка
 * копии своя (или её нет).
 */
export function e2eLinkedRoot(cwd: string): string | undefined {
  const link = join(cwd, PANEL_E2E_DIR);
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    return dirname(realpathSync.native(link));
  } catch {
    return undefined;
  }
}
