import { spawn, spawnSync } from 'node:child_process';
import { isWindows } from './project-runner.constants.ts';

/**
 * Работа с процессами ОС: разовые команды, убийство дерева, открытие браузера.
 * Всё, что зависит от платформы, живёт здесь и больше нигде.
 */

/** Строки вывода команды ОС; пустой массив, если команда недоступна. */
export function runLines(file: string, args: string[]): string[] {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || typeof result.stdout !== 'string') return [];
  return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** Убить дерево процессов: Windows — taskkill /T /F, POSIX — по группе. */
export function killTree(pid: number): void {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Процесса уже нет — нечего убивать.
    }
  }
}

/** Открыть URL в браузере ОС. Инъектируется в реестр — тест подставит заглушку. */
export function openBrowser(url: string): void {
  const child =
    process.platform === 'darwin'
      ? spawn('open', [url], { stdio: 'ignore', detached: true })
      : isWindows
        ? // cmd start: первый пустой аргумент — это заголовок окна, иначе URL
          // с пробелами будет принят за заголовок.
          spawn('cmd', ['/c', 'start', '', url], {
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
          })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.unref();
}
