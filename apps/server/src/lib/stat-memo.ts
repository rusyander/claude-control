import { statSync } from 'node:fs';

/**
 * Запомненный результат обхода диска, пока диск под ним не менялся.
 *
 * Вычисление само называет пути, на которые смотрело (`touch`): прочитанные
 * каталоги, файлы и места, где чего-то НЕ оказалось. Повторный запрос сверяет
 * время правки только их — десяток `stat` вместо обхода дерева и запуска git.
 * Каталог меняет время, когда в нём появилась, пропала или переименовалась
 * запись, поэтому новый файл теста, новая папка или правленный конфиг видны
 * сразу, без срока ожидания.
 *
 * Чего подписью не поймать (репозиторий заведён уровнем выше, файл правили
 * внутри той же миллисекунды), закрывает срок жизни `ttlMs`: дольше него
 * результат не живёт ни при каком раскладе.
 */
export interface StatMemoOptions {
  ttlMs: number;
  /** Сколько ключей держать; сверх — уходит самый давний. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry<T> {
  value: T;
  stamps: Map<string, number>;
  at: number;
}

/** Время правки пути; нет пути — `-1`, и его появление тоже меняет подпись. */
function stampOf(path: string): number {
  try {
    return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
  } catch {
    return -1;
  }
}

export class StatMemo<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: StatMemoOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 64;
    this.now = options.now ?? Date.now;
  }

  get(key: string, compute: (touch: (path: string) => void) => T): T {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs && this.unchanged(hit.stamps)) {
      return structuredClone(hit.value);
    }
    this.entries.delete(key);
    const startedAt = Date.now();
    const paths = new Set<string>();
    const value = compute((path) => paths.add(path));
    const stamps = new Map([...paths].map((path) => [path, stampOf(path)] as const));
    // Правка посреди обхода: подпись снята ПОСЛЕ чтения и уже совпала бы с
    // изменённым диском, а результат — нет. Такой результат не запоминается.
    const racing = [...stamps.values()].some((stamp) => stamp >= startedAt - 1);
    if (!racing) {
      this.entries.set(key, { value: structuredClone(value), stamps, at: this.now() });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return value;
  }

  /** Своя запись на диск: результат по ключу (или все) перечитывается сразу. */
  forget(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  private unchanged(stamps: ReadonlyMap<string, number>): boolean {
    for (const [path, stamp] of stamps) if (stampOf(path) !== stamp) return false;
    return true;
  }
}
