import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * `npx` и `python` на PATH подменены скриптом `fake-npx.mjs`: панель запускает
 * их через оболочку ровно так, как запускала бы настоящие, и ищет их по PATH.
 * Подмена — граница процесса каркаса, всё до неё (команда, env, отчёт, запись
 * истории) работает по-настоящему. `fileURLToPath`, а не `.pathname`: короткий
 * путь Windows (`RUSYAN~1`) иначе приходит как `%7E` и файл «не найден».
 */
/**
 * Раннер «установлен» в каталоге: `node_modules/.bin/<bin>`, как после
 * `npm install`. Панель без него команду не запускает — `npx` скачал бы раннер.
 */
export function markRunnerInstalled(dir: string, bin: string): void {
  const target = join(dir, 'node_modules', '.bin');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, process.platform === 'win32' ? `${bin}.cmd` : bin), '');
}

export function installFakeRunners(): { bin: string; restore: () => void } {
  const bin = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-fake-runners-')));
  const script = fileURLToPath(new URL('./fake-npx.mjs', import.meta.url));
  for (const name of ['npx', 'python', 'python3']) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\nnode "${script}" %*\r\n`);
    } else {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\nexec node "${script}" "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = `${bin}${process.platform === 'win32' ? ';' : ':'}${saved ?? ''}`;
  return {
    bin,
    restore: () => {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    },
  };
}
