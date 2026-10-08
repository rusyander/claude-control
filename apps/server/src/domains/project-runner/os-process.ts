import { spawn, spawnSync } from 'node:child_process';
import {
  killChildTree,
  killPidTree,
  type KillableChild,
} from '../../lib/process-tree/process-tree.ts';
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

/**
 * Убить дерево процессов по номеру: Windows — обход по времени создания
 * (`lib/process-tree/process-tree.ts`, без `taskkill /T`, который снимал чужих сирот),
 * POSIX — по группе: серверы проекта запускаются `detached`.
 */
export function killTree(pid: number): void {
  killPidTree(pid, { group: !isWindows });
}

/** Убить дерево запущенного нами сервера; вышедший по номеру не трогаем — номер мог стать чужим. */
export function killChildProcessTree(child: KillableChild): void {
  killChildTree(child, { group: !isWindows });
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
