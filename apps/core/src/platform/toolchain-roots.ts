import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from './exec-resolve.ts';
import { currentOs, envValue, homeDir, type OsKind } from './os-kind.ts';

/**
 * Кеши зависимостей и каталоги установленных инструментов — та часть области чтения сеанса,
 * которую знает только платформа (06 §Session permissions, F-87): модель читает типы пакета из
 * хранилища pnpm, исходник модуля Go, стандартную библиотеку Python — но не дом пользователя.
 * Источник — переменные окружения инструментов и их умолчания для ОС; путей пользователя здесь
 * нет. Каталоги, где инструмент держит токены (`~/.npmrc`, `~/.cargo/credentials.toml`), в список
 * не входят: из `~/.cargo` — только `registry` и `git`.
 *
 * Читает диск (настоящий путь программы, `VERSION` у корня Go) — один раз при старте ядра;
 * судья сравнивает уже готовый список.
 */

export interface ToolchainRootsOptions {
  env?: NodeJS.ProcessEnv;
  os?: OsKind;
  /** node, на котором идёт ядро; по умолчанию `process.execPath`. */
  execPath?: string;
  /** Корень копии: pnpm держит хранилище в `<корень тома>/.pnpm-store`, если дом на другом томе. */
  copyRoot?: string;
  /** Программа из PATH → её настоящий путь; `undefined` — нет. Тесты подменяют. */
  locate?: (command: string) => string | undefined;
}

function real(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

function locateOnPath(env: NodeJS.ProcessEnv, os: OsKind): (command: string) => string | undefined {
  return (command) => {
    const found = resolveExecutable(command, { env, os });
    return found.ok ? real(found.found) : undefined;
  };
}

/** Каталоги node: Windows — каталог установки (там же глобальный npm), POSIX — модули и заголовки. */
function nodeRoots(p: typeof path.posix, os: OsKind, exe: string): string[] {
  if (os === 'win32') return [p.dirname(exe)];
  const prefix = p.dirname(p.dirname(exe));
  return [p.join(prefix, 'lib', 'node_modules'), p.join(prefix, 'include', 'node')];
}

/**
 * Каталоги Python по настоящему пути интерпретатора. Windows — каталог установки (заглушка
 * магазина в `WindowsApps` — не установка). POSIX — `<prefix>/lib/pythonX.Y`, пользовательский
 * `site-packages` и Debian `dist-packages`; неверсионное имя — ничего: `<prefix>/lib` слишком широк.
 */
function pythonRoots(p: typeof path.posix, os: OsKind, exe: string, home: string): string[] {
  if (os === 'win32') {
    const dir = p.dirname(exe);
    return p.basename(dir).toLowerCase() === 'windowsapps' ? [] : [dir];
  }
  const name = p.basename(exe);
  if (!/^python\d+\.\d+$/.test(name)) return [];
  const prefix = p.dirname(p.dirname(exe));
  return [
    p.join(prefix, 'lib', name),
    p.join(prefix, 'lib', 'python3', 'dist-packages'),
    p.join(home, '.local', 'lib', name),
  ];
}

/** Корень Go по программе `go` (`<GOROOT>/bin/go`): признан, только если рядом есть `VERSION`. */
function goRoot(p: typeof path.posix, exe: string): string | undefined {
  const root = p.dirname(p.dirname(exe));
  return existsSync(p.join(root, 'VERSION')) ? root : undefined;
}

export function toolchainReadRoots(options: ToolchainRootsOptions = {}): string[] {
  const env = options.env ?? process.env;
  const os = options.os ?? currentOs();
  const p = os === 'win32' ? path.win32 : path.posix;
  const locate = options.locate ?? locateOnPath(env, os);
  const home = homeDir(env, os);
  const v = (name: string): string | undefined => envValue(env, name, os) || undefined;
  const local = v('LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local');
  const roaming = v('APPDATA') ?? p.join(home, 'AppData', 'Roaming');
  const cache = v('XDG_CACHE_HOME') ?? p.join(home, '.cache');
  const roots: (string | undefined)[] = [cache];

  // npm: кеш и глобальные пакеты.
  roots.push(
    v('npm_config_cache') ?? (os === 'win32' ? p.join(local, 'npm-cache') : p.join(home, '.npm')),
  );
  const npmPrefix = v('npm_config_prefix') ?? (os === 'win32' ? p.join(roaming, 'npm') : undefined);
  if (npmPrefix !== undefined) {
    roots.push(
      os === 'win32' ? p.join(npmPrefix, 'node_modules') : p.join(npmPrefix, 'lib', 'node_modules'),
    );
  }

  // pnpm: хранилище (явное, по умолчанию для ОС, на томе копии) и PNPM_HOME (глобальные пакеты).
  const dataHome = v('XDG_DATA_HOME') ?? p.join(home, '.local', 'share');
  const defaultStore = {
    win32: p.join(local, 'pnpm', 'store'),
    darwin: p.join(home, 'Library', 'pnpm', 'store'),
    linux: p.join(dataHome, 'pnpm', 'store'),
  }[os];
  roots.push(v('npm_config_store_dir') ?? defaultStore, v('PNPM_HOME'));
  if (options.copyRoot !== undefined && p.isAbsolute(options.copyRoot)) {
    roots.push(p.join(p.parse(options.copyRoot).root, '.pnpm-store'));
  }

  // pip: кеш колёс и исходников.
  const pipDefault = {
    win32: p.join(local, 'pip', 'Cache'),
    darwin: p.join(home, 'Library', 'Caches', 'pip'),
    linux: p.join(cache, 'pip'),
  }[os];
  roots.push(v('PIP_CACHE_DIR') ?? pipDefault);

  // Go: кеш модулей и корень установки.
  const gopath = v('GOPATH')
    ?.split(p.delimiter)
    .find((entry) => entry !== '');
  roots.push(v('GOMODCACHE') ?? p.join(gopath ?? p.join(home, 'go'), 'pkg', 'mod'), v('GOROOT'));
  const go = locate('go');
  if (go !== undefined) roots.push(goRoot(p, go));

  // Rust: исходники реестра и git-зависимостей, наборы инструментов (не `credentials.toml`).
  const cargo = v('CARGO_HOME') ?? p.join(home, '.cargo');
  const rustup = v('RUSTUP_HOME') ?? p.join(home, '.rustup');
  roots.push(p.join(cargo, 'registry'), p.join(cargo, 'git'), p.join(rustup, 'toolchains'));

  // node: тот, на котором идёт ядро, и тот, что найдёт сеанс в PATH.
  for (const exe of [options.execPath ?? process.execPath, locate('node')]) {
    if (exe !== undefined) roots.push(...nodeRoots(p, os, real(exe)));
  }

  // Python: окружение (venv, conda, PYTHONHOME) и интерпретатор из PATH.
  roots.push(v('VIRTUAL_ENV'), v('CONDA_PREFIX'), v('PYTHONHOME'));
  if (os === 'win32') roots.push(p.join(roaming, 'Python'));
  const python = locate('python3') ?? locate('python');
  if (python !== undefined) roots.push(...pythonRoots(p, os, python, home));

  const out: string[] = [];
  for (const root of roots) {
    if (root !== undefined && p.isAbsolute(root) && !out.includes(root)) out.push(root);
  }
  return out;
}
