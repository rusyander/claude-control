import { spawnSync } from 'node:child_process';

/**
 * Снятие процесса ВМЕСТЕ С ПОТОМКАМИ.
 *
 * `child.kill()` в наших запусках почти всегда убивает не то, что кажется: на
 * Windows команда идёт через `cmd.exe /c`, и сигнал получает оболочка, а сам CLI
 * (claude, vite, хук) остаётся жить — держит порт, файлы и токены. Пользователь
 * при этом видит «остановлено». Поэтому Windows валит дерево через
 * `taskkill /T /F`, а POSIX — группу процессов, но ТОЛЬКО если запуск был
 * `detached` и группа своя: иначе `kill(-pid)` снёс бы и сервер панели.
 *
 * Платформа читается функцией, а не константой модуля: тесты подменяют
 * `process.platform`, и захваченное на импорте значение подменить было бы нечем.
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Минимум, который нужен от дочернего процесса, — так его легко подделать в тесте. */
export interface KillableChild {
  pid?: number | undefined;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface KillOptions {
  /** Процесс запускался `detached` и возглавляет свою группу (только POSIX). */
  group?: boolean;
}

/** Убить дерево по PID. Ошибки глушим: снятие процесса не должно ронять ответ. */
export function killPidTree(pid: number, options: KillOptions = {}): void {
  if (isWindows()) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // taskkill может отсутствовать или отказать — дальше пробуем сигналом.
    }
    return;
  }

  if (options.group) {
    try {
      process.kill(-pid, 'SIGTERM');
      return;
    } catch {
      // Группы нет (процесс запускали не detached) — валим сам процесс.
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Процесса уже нет — это не ошибка.
    }
  }
}

/**
 * Убить дерево дочернего процесса. `child.kill()` в конце обязателен: на Windows
 * он добивает саму оболочку, а на POSIX — единственное, что вообще произошло,
 * если PID уже неизвестен.
 */
export function killChildTree(child: KillableChild, options: KillOptions = {}): void {
  if (child.pid) killPidTree(child.pid, options);
  try {
    child.kill();
  } catch {
    // Процесс уже завершился — повторный сигнал не ошибка.
  }
}
