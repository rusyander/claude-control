import {
  childIsRunning,
  killOrphanGroup,
  killProcessTree,
  readPosixProcessTable,
  readProcessTable,
  stopTreeWithGrace,
  type ProcessRow,
  type TreeKillImpl,
} from '../kill-tree.mjs';

/**
 * Снятие процесса ВМЕСТЕ С ПОТОМКАМИ.
 *
 * `child.kill()` в наших запусках почти всегда убивает не то, что кажется: на
 * Windows команда идёт через `cmd.exe /c`, и сигнал получает оболочка, а сам CLI
 * (claude, vite, хук) остаётся жить — держит порт, файлы и токены. Пользователь
 * при этом видит «остановлено». Поэтому Windows валит дерево, а POSIX — группу
 * процессов, но ТОЛЬКО если запуск был `detached` и группа своя: иначе
 * `kill(-pid)` снёс бы и сервер панели.
 *
 * Дерево Windows обходим сами (`kill-tree.mjs`), а не `taskkill /T`: тот
 * верит записанному номеру родителя, которую Windows не чистит, и снимал чужую
 * сироту, чей мёртвый родитель отдал номер нашему процессу (2026-09-27 так ушёл
 * живой сторож стенда). Там же — почему снимок стоит ~0.3–0.5 с и почему это
 * синхронно.
 *
 * Платформа читается при вызове, а не константой модуля: тесты подменяют
 * `process.platform`, и захваченное на импорте значение подменить было бы нечем.
 */

/**
 * Минимум, который нужен от дочернего процесса, — форма `ChildProcess`. Коды
 * выхода обязательны: по номеру снимаем, только пока оба `null` (процесс жив, и
 * libuv держит его номер), — вышедший мог отдать номер чужому.
 */
export interface KillableChild {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface KillOptions {
  /** Процесс запускался `detached` и возглавляет свою группу (только POSIX). */
  group?: boolean;
  /**
   * Для голого номера из журнала: момент (мс Unix), когда процесс точно был нашим
   * — сразу после запуска или позже. Корень, созданный позже, — чужой процесс на
   * освободившемся номере, и его не трогаем (время создания — из снимка процессов:
   * Windows, на POSIX `ps … etime`; снимка нет — не трогаем вовсе). У живого
   * `ChildProcess` не нужен: номер держит открытый дескриптор.
   */
  spawnedAt?: number;
  /**
   * Снять потомков одним снимком, а корень оставить (посредник живой сессии):
   * пока дерево цело, его видно целиком. Снимка нет — не снимается ничего.
   */
  keepRoot?: boolean;
}

/**
 * Номера процессов, снятых нарочно, — на минуту. На Windows снятие даёт
 * процессу код выхода 1 без всякого сигнала (`TerminateProcess`, как и
 * `taskkill /F`), и по коду снятый стопом CLI не отличить от упавшего; фоновый
 * наблюдатель спрашивает здесь.
 */
const STOPPED_TTL_MS = 60_000;
const stoppedOnPurpose = new Map<number, number>();

export function wasStoppedOnPurpose(pid: number, now = Date.now()): boolean {
  const at = stoppedOnPurpose.get(pid);
  return at !== undefined && now - at < STOPPED_TTL_MS;
}

function markStopped(pid: number): void {
  const now = Date.now();
  stoppedOnPurpose.set(pid, now);
  if (stoppedOnPurpose.size > 500) {
    for (const [key, at] of stoppedOnPurpose)
      if (now - at >= STOPPED_TTL_MS) stoppedOnPurpose.delete(key);
  }
}

/**
 * Один снимок процессов на пачку снятий (23.10): «Остановить всё», пауза дерева
 * и выход панели снимают N сессий подряд, а снимок Windows синхронный и стоит
 * ~0,8 с — N раз подряд сервер стоял секундами. Внутри `withProcessSnapshot`
 * первый `killPidTree` читает снимок, остальные берут его же. Снимок старее
 * снятий — не беда: снятие сверяет время создания по дескриптору, а вышедший
 * номер даёт «gone». Пропустить можно лишь процесс, родившийся за эти
 * миллисекунды синхронного цикла.
 */
let shared: { table?: ProcessRow[] | undefined; read: boolean } | undefined;

export function withProcessSnapshot<T>(fn: () => T): T {
  // Вложенный вызов живёт в снимке внешнего: пачка одна.
  if (shared) return fn();
  shared = { read: false };
  try {
    return fn();
  } finally {
    shared = undefined;
  }
}

function sharedImpl(): TreeKillImpl | undefined {
  const scope = shared;
  if (!scope) return undefined;
  return {
    readTable: () => {
      if (!scope.read) {
        scope.read = true;
        scope.table = process.platform === 'win32' ? readProcessTable() : readPosixProcessTable();
      }
      return scope.table;
    },
  };
}

/**
 * Убить дерево по PID. Ошибки глушим: снятие процесса не должно ронять ответ.
 * Возвращает номера, по которым ушёл сигнал; `impl` — подмена для тестов.
 */
export function killPidTree(pid: number, options: KillOptions = {}, impl?: TreeKillImpl): number[] {
  try {
    return killProcessTree(pid, { ...options, onKill: markStopped }, impl ?? sharedImpl());
  } catch {
    // Снимок или сигнал отказали неожиданно — ответ пользователю важнее.
    return [];
  }
}

/**
 * Убить дерево дочернего процесса — по номеру только пока он жив
 * (`childIsRunning`). `child.kill()` в конце обязателен: на Windows он добивает
 * саму оболочку, а на POSIX — единственное, что вообще произошло, если PID уже
 * неизвестен.
 */
export function killChildTree(
  child: KillableChild,
  options: KillOptions = {},
  impl?: TreeKillImpl,
): void {
  if (child.pid && childIsRunning(child)) killPidTree(child.pid, options, impl);
  // Лидер своей группы вышел, а её члены живы (оболочка `… & exit`) — группу
  // снимаем по её номеру; проверка «номер не переиспользован» — внутри (F-308).
  else if (child.pid && options.group) killOrphanGroup(child.pid, impl);
  try {
    child.kill();
  } catch {
    // Процесс уже завершился — повторный сигнал не ошибка.
  }
}

/**
 * `killChildTree` и через `graceMs` — SIGKILL корню, пропустившему мягкий сигнал
 * (POSIX: `trap '' TERM`): иначе ждущий его выхода ждал бы вечно. Добивание —
 * общее с CLI тестов (`stopTreeWithGrace`), а не своя копия у каждого вызывающего;
 * таймер не держит выход панели. Возвращает отмену добивания.
 */
export function stopChildTree(
  child: KillableChild,
  options: KillOptions & { graceMs?: number } = {},
  impl?: TreeKillImpl,
): () => void {
  const { graceMs, ...kill } = options;
  return stopTreeWithGrace(
    child,
    { ...(graceMs !== undefined ? { graceMs } : {}), unref: true },
    { killChild: (target) => killChildTree(target, kill, impl) },
  );
}
