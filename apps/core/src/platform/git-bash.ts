import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `bash.exe` Git для Windows рядом с найденным `git`: раскладка установки — факт платформы
 * (P51), а не переходника. `git.exe` лежит в `<корень>/cmd`, `<корень>/bin` или
 * `<корень>/mingw64/bin`; оболочка — `<корень>/bin/bash.exe`. Не нашлась — `null`.
 */
export function gitBashNextTo(gitFile: string): string | null {
  let dir = dirname(gitFile);
  for (let up = 0; up < 3; up++) {
    const bash = join(dir, 'bin', 'bash.exe');
    if (existsSync(bash)) return bash;
    dir = dirname(dir);
  }
  return null;
}
