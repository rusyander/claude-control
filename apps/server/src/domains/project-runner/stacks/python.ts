import { join } from 'node:path';
import { findUp, isDir, isFile, listDir, readText, relPath, shownPath } from './fs-probe.ts';
import type { StackCandidate, StackProbe } from './stacks.types.ts';

/**
 * Python: Django, FastAPI, Flask и простой скрипт с `__main__`.
 *
 * Интерпретатор берётся так, как его взял бы сам проект: uv.lock → `uv run`,
 * poetry.lock → `poetry run`, локальное `.venv` → его python, иначе системный.
 * Системный python без venv почти никогда не видит зависимостей проекта, поэтому
 * он последний — и это видно в команде, а не спрятано.
 */

const IS_WINDOWS = process.platform === 'win32';

/** Признаки Python-проекта в самом каталоге цели. */
const MARKERS = [
  'pyproject.toml',
  'requirements.txt',
  'requirements-dev.txt',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'manage.py',
  'uv.lock',
  'poetry.lock',
];

/** Где обычно лежит объект приложения. */
const APP_FILES = ['main.py', 'app.py', 'server.py', 'api.py', 'asgi.py', 'wsgi.py'];
/** Каталоги, где приложения не ищем: тесты, окружения, миграции. */
const SKIP_DIRS = new Set([
  'tests',
  'test',
  'venv',
  'env',
  'node_modules',
  'migrations',
  'alembic',
  'docs',
  'scripts',
  '__pycache__',
  'build',
  'dist',
]);

interface PythonRunner {
  /** Как интерпретатор показан человеку: `uv run`, `.venv\Scripts\python.exe`. */
  shown: string;
  file: string;
  prefix: string[];
  /** Запускает ли раннер консольные скрипты пакетов напрямую (`uv run uvicorn`). */
  runsScripts: boolean;
  tool?: string;
  toolPath?: string;
  evidence: string[];
}

function venvPython(base: string): string | undefined {
  for (const name of ['.venv', 'venv']) {
    const exe = IS_WINDOWS
      ? join(base, name, 'Scripts', 'python.exe')
      : join(base, name, 'bin', 'python');
    if (isFile(exe)) return exe;
  }
  return undefined;
}

export function pythonRunner(dir: string, root: string): PythonRunner {
  const uvDir = findUp(dir, root, ['uv.lock']);
  if (uvDir) {
    return {
      shown: 'uv run',
      file: 'uv',
      prefix: ['run'],
      runsScripts: true,
      tool: 'uv',
      evidence: [join(uvDir, 'uv.lock')],
    };
  }
  const poetryDir = findUp(dir, root, ['poetry.lock']);
  if (poetryDir) {
    return {
      shown: 'poetry run',
      file: 'poetry',
      prefix: ['run'],
      runsScripts: true,
      tool: 'poetry',
      evidence: [join(poetryDir, 'poetry.lock')],
    };
  }
  const venv = venvPython(dir) ?? venvPython(root);
  if (venv) {
    return {
      shown: shownPath(dir, venv),
      file: venv,
      prefix: [],
      runsScripts: false,
      toolPath: venv,
      evidence: [],
    };
  }
  const system = IS_WINDOWS ? 'python' : 'python3';
  return {
    shown: system,
    file: system,
    prefix: [],
    runsScripts: false,
    tool: system,
    evidence: [],
  };
}

/** Команда «запустить консольный скрипт пакета» (`uvicorn`, `flask`) этим раннером. */
function scriptCommand(runner: PythonRunner, script: string, args: string[]) {
  const tail = runner.runsScripts ? [script, ...args] : ['-m', script, ...args];
  return {
    file: runner.file,
    args: [...runner.prefix, ...tail],
    display: [runner.shown, ...tail].join(' '),
  };
}

/** Команда «запустить python-файл» этим раннером. */
function fileCommand(runner: PythonRunner, args: string[]) {
  const tail = runner.runsScripts ? ['python', ...args] : args;
  return {
    file: runner.file,
    args: [...runner.prefix, ...tail],
    display: [runner.shown, ...tail].join(' '),
  };
}

/** Файлы, где может жить объект приложения: в каталоге, на уровень ниже и в `src/<пакет>`. */
function appFiles(dir: string): string[] {
  const files = APP_FILES.map((name) => join(dir, name));
  const subdirs = (base: string) =>
    listDir(base).filter(
      (name) => !name.startsWith('.') && !SKIP_DIRS.has(name) && isDir(join(base, name)),
    );
  for (const sub of subdirs(dir)) {
    if (sub === 'src') continue;
    files.push(...APP_FILES.map((name) => join(dir, sub, name)));
  }
  for (const sub of subdirs(join(dir, 'src'))) {
    files.push(...APP_FILES.map((name) => join(dir, 'src', sub, name)));
  }
  return files.filter(isFile).slice(0, 80);
}

/**
 * Модуль и объект приложения в форме `пакет.модуль:объект`. Для src-раскладки
 * модуль считается от `src`, и uvicorn/flask получают `--app-dir src`.
 */
function appTarget(dir: string, file: string, variable: string) {
  const rel = relPath(dir, file).replace(/\.py$/, '');
  const inSrc = rel.startsWith('src/');
  const module = (inSrc ? rel.slice(4) : rel).split('/').join('.');
  return { ref: `${module}:${variable}`, inSrc };
}

const FASTAPI = /^(\w+)\s*(?::[^=\n]*)?=\s*FastAPI\s*\(/m;
const FLASK = /^(\w+)\s*(?::[^=\n]*)?=\s*Flask\s*\(/m;
const MAIN_GUARD = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m;

export function pythonCandidates({ dir, root }: StackProbe): StackCandidate[] {
  if (!MARKERS.some((name) => isFile(join(dir, name)))) return [];
  const runner = pythonRunner(dir, root);
  const base = {
    stack: 'python' as const,
    ...(runner.tool ? { tool: runner.tool } : {}),
    ...(runner.toolPath ? { toolPath: runner.toolPath } : {}),
  };
  const found: StackCandidate[] = [];

  const manage = join(dir, 'manage.py');
  if (isFile(manage)) {
    found.push({
      ...base,
      framework: 'Django',
      evidence: [manage, ...runner.evidence],
      ...fileCommand(runner, ['manage.py', 'runserver']),
      pinPort: (port) => ({ args: [`127.0.0.1:${port}`] }),
    });
  }

  const files = appFiles(dir);
  const sources = files.map((file) => ({ file, text: readText(file) ?? '' }));

  for (const { file, text } of sources) {
    const variable = FASTAPI.exec(text)?.[1];
    if (!variable) continue;
    const app = appTarget(dir, file, variable);
    const args = [app.ref, '--reload', ...(app.inSrc ? ['--app-dir', 'src'] : [])];
    found.push({
      ...base,
      framework: 'FastAPI',
      evidence: [file, ...runner.evidence],
      ...scriptCommand(runner, 'uvicorn', args),
      pinPort: (port) => ({ args: ['--port', String(port)] }),
    });
  }

  for (const { file, text } of sources) {
    const variable = FLASK.exec(text)?.[1];
    if (!variable) continue;
    const app = appTarget(dir, file, variable);
    const ref = app.inSrc ? `src/${app.ref}` : app.ref;
    found.push({
      ...base,
      framework: 'Flask',
      evidence: [file, ...runner.evidence],
      ...scriptCommand(runner, 'flask', ['--app', ref, 'run', '--debug']),
      pinPort: (port) => ({ args: ['--port', String(port)] }),
    });
  }

  // Простой скрипт с `if __name__ == "__main__":` — только в самом каталоге:
  // в подпапках такие файлы чаще утилиты, чем сервис.
  for (const { file, text } of sources) {
    if (relPath(dir, file).includes('/') || !MAIN_GUARD.test(text)) continue;
    found.push({
      ...base,
      evidence: [file, ...runner.evidence],
      ...fileCommand(runner, [relPath(dir, file)]),
    });
  }

  return found;
}
