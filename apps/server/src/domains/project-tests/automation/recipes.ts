import { join } from 'node:path';
import type {
  ProjectTestAutomationCommand,
  ProjectTestAutomationRecipe,
  ProjectTestRecipeStack,
} from '@agentdeck/contracts';
import { detectCliOnPath } from '../../../providers/detect/detect.ts';
import {
  findUp,
  isDir,
  isFile,
  listDir,
  readText,
  relPath,
} from '../../project-runner/stacks/fs-probe.ts';
import { pythonRunner } from '../../project-runner/stacks/python.ts';

/**
 * Готовые команды прогона для бэкенд-проектов: Go, pytest, Gradle, Maven, Cargo.
 *
 * Рецепт пишет отчёт тем, что есть у самого инструмента, без сторонних
 * конвертеров: Go — `go test -json`, Cargo — обычный вывод `cargo test`
 * (оба переводит в JUnit панель), pytest — `--junitxml`, Gradle и Maven —
 * свой каталог JUnit-отчётов. Так рецепт идёт сразу, а недостающая программа —
 * только сам инструмент, и она названа до прогона.
 *
 * Модуль в каталоге, а не в корне — команда начинается с `cd <каталог> &&`:
 * так пишут и cmd, и sh, а `{report}` — абсолютный путь и переход переживает.
 * Такой рецепт гонит весь набор модуля: пути файлов кейсов — от корня проекта,
 * и сузить ими прогон внутри каталога нельзя.
 */

const IS_WINDOWS = process.platform === 'win32';
/** Глубина поиска модулей: корень, `backend/`, `services/api/`. */
const MODULE_DEPTH = 2;
/** Сколько файлов тестов считать: дальше число неважно, а обход дорогой. */
const COUNT_CAP = 500;
const COUNT_DEPTH = 8;
const SKIP = new Set([
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
]);

type ToolCheck = (tool: string) => boolean;

const skipped = (name: string): boolean => name.startsWith('.') || SKIP.has(name);

/** Каталоги-кандидаты в модули: корень и подкаталоги до `MODULE_DEPTH`. */
function moduleDirs(root: string): string[] {
  const found = [root];
  let level = [root];
  for (let depth = 0; depth < MODULE_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      for (const name of listDir(dir)) {
        const path = join(dir, name);
        if (!skipped(name) && isDir(path)) next.push(path);
      }
    }
    found.push(...next);
    level = next;
  }
  return found;
}

/** Сколько файлов под `dir` подходят под `match` — с потолком. */
function countFiles(dir: string, match: (name: string, path: string) => boolean): number {
  let count = 0;
  const walk = (current: string, depth: number): void => {
    for (const name of listDir(current)) {
      if (count >= COUNT_CAP) return;
      const path = join(current, name);
      if (isDir(path)) {
        if (depth < COUNT_DEPTH && !skipped(name)) walk(path, depth + 1);
      } else if (match(name, path)) {
        count += 1;
      }
    }
  };
  walk(dir, 0);
  return count;
}

interface Draft {
  stack: ProjectTestRecipeStack;
  /** Каталог запуска команды. */
  dir: string;
  /** Каталог модуля, если запуск не из него (подпроект Gradle — из каталога обёртки). */
  module?: string;
  evidence: string[];
  tests: number;
  /** Команда без перехода в каталог: его добавит `finish`. */
  command: string;
  /** Отчёт от корня МОДУЛЯ; нет — назначает панель (`{report}`). */
  report?: string;
  format?: ProjectTestAutomationCommand['format'];
  timeoutMinutes: number;
  tool: string;
  /** Файл-обёртка в проекте: доступна, если существует. */
  toolPath?: string;
  install: string;
  /** Команда умеет сузиться до файлов кейсов (`{paths}`/`{packages}`). */
  narrows: boolean;
}

function goRecipe(dir: string): Draft | undefined {
  const mod = join(dir, 'go.mod');
  if (!isFile(mod)) return undefined;
  const tests = countFiles(dir, (name) => name.endsWith('_test.go'));
  if (tests === 0) return undefined;
  return {
    stack: 'go',
    dir,
    evidence: [mod],
    tests,
    command: 'go test -json {packages} > {report}',
    format: 'go-test-json',
    timeoutMinutes: 30,
    tool: 'go',
    install: 'https://go.dev/dl/',
    narrows: true,
  };
}

const PYTEST_CONFIG = /^\[tool\.pytest|^\[tool:pytest\]|^\[pytest\]/m;

function pytestRecipe(dir: string, root: string): Draft | undefined {
  const config = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']
    .map((name) => join(dir, name))
    .filter((path) => isFile(path) && PYTEST_CONFIG.test(readText(path) ?? ''));
  const conftest = join(dir, 'conftest.py');
  const tests = countFiles(dir, (name) => /^test_.+\.py$|.+_test\.py$/.test(name));
  if (tests === 0) return undefined;
  // Без конфига и conftest файлы test_*.py ещё не значат pytest — это может
  // быть unittest; нужен хоть один признак проекта Python.
  const project = ['pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock', 'poetry.lock']
    .map((name) => join(dir, name))
    .filter(isFile);
  if (config.length === 0 && !isFile(conftest) && project.length === 0) return undefined;

  const runner = pythonRunner(dir, root);
  const evidence = [...config, ...(isFile(conftest) ? [conftest] : []), ...runner.evidence];
  const base = {
    stack: 'pytest' as const,
    dir,
    evidence: evidence.length > 0 ? evidence : project.slice(0, 1),
    tests,
    timeoutMinutes: 30,
    narrows: true,
  };
  const tail = 'pytest --junitxml={report} {paths}';
  if (runner.file === 'uv') {
    // `--with pytest`: рецепт идёт и там, где pytest не записан в зависимости.
    return {
      ...base,
      command: `uv run --with pytest ${tail}`,
      tool: 'uv',
      install: 'https://docs.astral.sh/uv/',
    };
  }
  if (runner.file === 'poetry') {
    return {
      ...base,
      command: `poetry run ${tail}`,
      tool: 'poetry',
      install: 'poetry add --group dev pytest',
    };
  }
  if (runner.toolPath) {
    // Python окружения проекта: pytest должен стоять В НЁМ, а не где-то в PATH.
    const scripts = join(runner.toolPath, '..');
    const pytest = join(scripts, IS_WINDOWS ? 'pytest.exe' : 'pytest');
    return {
      ...base,
      command: `"${runner.toolPath}" -m ${tail}`,
      tool: 'pytest',
      toolPath: pytest,
      install: `"${runner.toolPath}" -m pip install pytest`,
    };
  }
  return {
    ...base,
    command: `${runner.file} -m ${tail}`,
    tool: runner.file,
    install: 'https://www.python.org/downloads/',
  };
}

/** Есть ли у JVM-модуля тесты: `src/test/**` с исходниками. */
function jvmTests(dir: string): number {
  const tests = join(dir, 'src', 'test');
  return isDir(tests) ? countFiles(tests, (name) => /\.(java|kt|groovy|scala)$/.test(name)) : 0;
}

/** Обёртка сборщика от модуля вверх до корня; команда — как её набрали бы в каталоге обёртки. */
function wrapperOf(dir: string, root: string, posixName: string, windowsName: string) {
  const name = IS_WINDOWS ? windowsName : posixName;
  const at = findUp(dir, root, [name]);
  if (!at) return undefined;
  // cmd находит `gradlew.bat` по `gradlew` в текущем каталоге, sh — только по `./gradlew`.
  return { dir: at, path: join(at, name), command: IS_WINDOWS ? posixName : `./${posixName}` };
}

function gradleRecipe(dir: string, root: string): Draft | undefined {
  const build = ['build.gradle.kts', 'build.gradle'].map((name) => join(dir, name)).find(isFile);
  if (!build) return undefined;
  const tests = jvmTests(dir);
  if (tests === 0) return undefined;
  const wrap = wrapperOf(dir, root, 'gradlew', 'gradlew.bat');
  // `cleanTest`: без него Gradle считает тесты «уже выполненными» и не пишет
  // свежих отчётов — прогон выглядел бы как «отчёт не появился».
  const sub = wrap && wrap.dir !== dir ? `:${relPath(wrap.dir, dir).split('/').join(':')}:` : '';
  return {
    stack: 'gradle',
    dir: wrap?.dir ?? dir,
    module: dir,
    evidence: [build, ...(wrap ? [wrap.path] : [])],
    tests,
    command: `${wrap?.command ?? 'gradle'} ${sub}cleanTest ${sub}test`,
    report: `${relPath(wrap?.dir ?? dir, join(dir, 'build', 'test-results', 'test'))}/`,
    timeoutMinutes: 60,
    tool: 'gradle',
    ...(wrap ? { toolPath: wrap.path } : {}),
    install: 'https://gradle.org/install/',
    narrows: false,
  };
}

function mavenRecipe(dir: string, root: string): Draft | undefined {
  const pom = join(dir, 'pom.xml');
  if (!isFile(pom)) return undefined;
  const tests = jvmTests(dir);
  if (tests === 0) return undefined;
  const wrap = wrapperOf(dir, dir, 'mvnw', 'mvnw.cmd') ?? wrapperOf(dir, root, 'mvnw', 'mvnw.cmd');
  const tool = wrap && wrap.dir === dir ? wrap.command : 'mvn';
  return {
    stack: 'maven',
    dir,
    evidence: [pom, ...(wrap && wrap.dir === dir ? [wrap.path] : [])],
    tests,
    // `-fae`: упавший модуль не отменяет тесты остальных — иначе половина
    // кейсов осталась бы без результата из-за одного красного.
    command: `${tool} -B -fae test`,
    report: 'target/surefire-reports/',
    timeoutMinutes: 60,
    tool: 'mvn',
    ...(wrap && wrap.dir === dir ? { toolPath: wrap.path } : {}),
    install: 'https://maven.apache.org/install.html',
    narrows: false,
  };
}

function cargoRecipe(dir: string): Draft | undefined {
  const manifest = join(dir, 'Cargo.toml');
  const text = readText(manifest);
  if (!text || !/^\[(package|workspace)\]/m.test(text)) return undefined;
  const tests = countFiles(dir, (name, path) => {
    if (!name.endsWith('.rs')) return false;
    return /#\[(tokio::)?test\]/.test(readText(path) ?? '');
  });
  if (tests === 0) return undefined;
  const workspace = /^\[workspace\]/m.test(text) ? ' --workspace' : '';
  return {
    stack: 'cargo',
    dir,
    evidence: [manifest],
    tests,
    // Поток ошибок — в тот же файл: строки `Running unittests src/lib.rs`
    // cargo печатает туда, а по ним тест находит свой файл.
    command: `cargo test${workspace} --no-fail-fast > {report} 2>&1`,
    format: 'cargo-test',
    timeoutMinutes: 30,
    tool: 'cargo',
    install: 'https://rustup.rs',
    narrows: false,
  };
}

function finish(root: string, draft: Draft, hasTool: ToolCheck): ProjectTestAutomationRecipe {
  const fromRoot = (path: string): string => (path === root ? '' : relPath(root, path));
  const dir = fromRoot(draft.dir);
  const module = fromRoot(draft.module ?? draft.dir);
  const command = dir
    ? `cd ${dir.includes(' ') ? `"${dir}"` : dir} && ${draft.command}`
    : draft.command;
  const available = draft.toolPath ? isFile(draft.toolPath) : hasTool(draft.tool);
  const automation: ProjectTestAutomationCommand = {
    // Из каталога модуля пути кейсов от корня не годятся: подстановки — пустые.
    command: dir ? command.replace(' {paths}', '').replace('{packages}', './...') : command,
    ...(draft.report ? { report: dir ? `${dir}/${draft.report}` : draft.report } : {}),
    timeoutMinutes: draft.timeoutMinutes,
    ...(draft.format ? { format: draft.format } : {}),
  };
  return {
    id: `${draft.stack}:${module}`,
    stack: draft.stack,
    dir: module,
    evidence: draft.evidence.map((path) => relPath(root, path)),
    tests: draft.tests,
    automation,
    tool: draft.tool,
    ...(available ? {} : { missing: true }),
    install: draft.install,
    wholeSuite: Boolean(module) || !draft.narrows,
  };
}

/** Все рецепты проекта: модули по глубине, в каждом — все узнанные стеки. */
export function automationRecipes(
  root: string,
  hasTool: ToolCheck = detectCliOnPath,
): ProjectTestAutomationRecipe[] {
  const recipes: ProjectTestAutomationRecipe[] = [];
  const seen = new Set<string>();
  for (const dir of moduleDirs(root)) {
    const drafts = [
      goRecipe(dir),
      pytestRecipe(dir, root),
      gradleRecipe(dir, root),
      mavenRecipe(dir, root),
      cargoRecipe(dir),
    ];
    for (const draft of drafts) {
      if (!draft) continue;
      const recipe = finish(root, draft, hasTool);
      if (seen.has(recipe.id)) continue;
      seen.add(recipe.id);
      recipes.push(recipe);
    }
  }
  return recipes;
}
