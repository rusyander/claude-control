import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from './os-kind.ts';
import { resolveExecutable } from './exec-resolve.ts';
import { isInside } from './paths.ts';
import { pinEnv } from './spawn.ts';

/**
 * Отпечаток УСТАНОВЛЕННОГО инструмента для ключа проверки (D§3.3 `toolVersions`). Объявленная
 * проектом версия (`.nvmrc`, engines) — не то, что исполнится: без объявления node 20 и node 22
 * дали бы один ключ. Ничего не запускается — `--version` у инструмента из CI мог бы оказаться
 * скриптом репозитория (`./deploy.sh`): отпечаток — размер и время правки файлов, которые
 * исполнятся (цель и скрипт перед argv, тот же поиск, что у запуска). Переустановка той же
 * версии — лишь промах. Инструмент внутри копии — `repo`: его содержимое уже в дереве ключа.
 * Найденный файл не читается — `unknown` (ключа нет → прогон), никогда строка-заглушка.
 */

/** Имя инструмента в профиле ≠ имя файла: `maven` в PATH не бывает никогда. */
const BINARY_OF: Record<string, string> = { maven: 'mvn' };

/**
 * Шим менеджера версий (volta, asdf, mise, pyenv, rbenv, nodenv) — один файл на все версии:
 * версию выбирают глобальный файл менеджера и переменные `*_VERSION`. Они входят в отпечаток,
 * иначе `pyenv global 3.12` без `.python-version` повторил бы зелёный 3.11. Файлы выбора внутри
 * копии уже в дереве ключа; файл выбора в папке ВЫШЕ копии не виден — остаток, не закрыт.
 */
const SHIM_DIRS =
  /[\\/](\.volta[\\/]bin|\.asdf[\\/]shims|mise[\\/]shims|\.pyenv[\\/]shims|pyenv-win[\\/]shims|\.rbenv[\\/]shims|\.nodenv[\\/]shims)[\\/]/i;
const VERSION_ENV = /^(PYENV|RBENV|NODENV)_VERSION$|^(ASDF|MISE)_\w+_VERSION$/;

function shimSelectors(env: Record<string, string>): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const at = (root: string | undefined, fallback: string, ...rest: string[]) =>
    join(root || join(home, fallback), ...rest);
  return [
    at(env.VOLTA_HOME, '.volta', 'tools', 'user', 'platform.json'),
    at(undefined, '', '.tool-versions'),
    at(env.MISE_CONFIG_DIR, join('.config', 'mise'), 'config.toml'),
    at(env.PYENV_ROOT ?? env.PYENV, '.pyenv', 'version'),
    at(env.PYENV, join('.pyenv', 'pyenv-win'), 'version'),
    at(env.RBENV_ROOT, '.rbenv', 'version'),
    at(env.NODENV_ROOT, '.nodenv', 'version'),
  ];
}

function statPart(file: string): string | undefined {
  try {
    const s = statSync(file);
    return s.isFile() ? `${s.size}:${Math.trunc(s.mtimeMs)}` : undefined;
  } catch {
    return undefined;
  }
}

export function toolStamp(
  command: string,
  copyDir: string,
  env: Record<string, string>,
): Fact<string> {
  // Явный относительный путь — от копии, как у запуска (`spawnResolved` с cwd копии): иначе ключ
  // зависел бы от каталога, где стоит ядро (B1r3-F02).
  const found = resolveExecutable(BINARY_OF[command] ?? command, {
    env: pinEnv(env),
    cwd: copyDir,
  });
  // Нет в PATH — тоже факт о машине (проверка идёт обёрткой репозитория, `./gradlew`):
  // поставят позже — ключ сменится.
  if (!('found' in found)) return { value: 'absent' };
  if (isInside(copyDir, found.found)) return { value: 'repo' };
  // Обёртка, которую ядро само не запустит (`gradle.bat` из zip) — всё равно файл на диске:
  // для отпечатка оболочка не нужна, нужен stat.
  const files = found.ok ? [found.file, ...found.prefix] : [found.found];
  const parts: string[] = [];
  for (const file of files) {
    const part = statPart(file);
    // Флаг node в prefix — не файл; сам исполняемый файл обязан читаться.
    if (part === undefined && file === files[0])
      return { unknown: `${command}: cannot stat ${file}` };
    if (part !== undefined) parts.push(part);
  }
  if (SHIM_DIRS.test(found.found)) {
    for (const file of shimSelectors(env)) parts.push(statPart(file) ?? '-');
    for (const name of Object.keys(env)
      .filter((k) => VERSION_ENV.test(k))
      .sort())
      parts.push(`${name}=${env[name]}`);
  }
  return { value: parts.join('+') };
}
