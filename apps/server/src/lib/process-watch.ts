import {
  filetimeFromMs,
  killLeftovers,
  planLeftoverKill,
  readProcessTableAsync,
  WATCH_SLACK_MS,
  type ProcessRow,
} from './kill-tree.mjs';

/**
 * Наблюдение за деревом процессов команды во время её прогона (Ф9).
 *
 * Помощник команды (dev-сервер, наблюдатель), переживший её выход, после выхода
 * уже не найти обходом от корня: на Windows дерево строится по номеру родителя,
 * а родитель мёртв. Поэтому дерево записывается, пока команда жива: опрос
 * снимка раз в `intervalMs` копит `pid → время создания` её потомков. По концу
 * добиваются живые из записанных и их дети — по тому же времени создания, так
 * что процесс, занявший освободившийся номер, не тронут.
 */

export interface DescendantWatch {
  /** Замеченные процессы дерева: `pid → created` (тики FILETIME). */
  readonly known: Map<number, bigint>;
  /** Остановить опрос; дожидается идущего снимка. */
  stop: () => Promise<void>;
  /** Добить живое из замеченного; номера, по которым ушёл сигнал. */
  killLeftovers: () => number[];
}

export interface WatchOptions {
  intervalMs?: number;
  /** Подмена снимка в тестах. */
  readTable?: () => Promise<ProcessRow[] | undefined>;
}

const DEFAULT_INTERVAL_MS = 1_000;

export function watchDescendants(
  rootPid: number,
  spawnedAt: number,
  options: WatchOptions = {},
): DescendantWatch {
  const known = new Map<number, bigint>();
  const readTable = options.readTable ?? (() => readProcessTableAsync());
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  const absorb = (table: ProcessRow[]): void => {
    if (known.size === 0) {
      // Корень признаётся, только если создан не раньше запуска: иначе номер
      // уже отдан другому, и его дерево — чужое.
      const root = table.find((row) => row.pid === rootPid);
      if (!root || root.created < filetimeFromMs(spawnedAt - WATCH_SLACK_MS)) return;
      known.set(rootPid, root.created);
    }
    const created = new Map(table.map((row) => [row.pid, row.created]));
    for (const pid of planLeftoverKill(table, known)) {
      const at = created.get(pid);
      if (at !== undefined && !known.has(pid)) known.set(pid, at);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = readTable()
      .then((table) => {
        if (table && !stopped) absorb(table);
      })
      .catch(() => {
        // Снимок не вышел — следующий опрос.
      })
      .finally(() => {
        inFlight = undefined;
        if (!stopped) {
          timer = setTimeout(tick, interval);
          timer.unref?.();
        }
      });
  };
  tick();

  return {
    known,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    killLeftovers: () => {
      try {
        return killLeftovers(known);
      } catch {
        return [];
      }
    },
  };
}
