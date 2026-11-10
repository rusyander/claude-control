import type { BoardEntry } from '@agentdeck/contracts/core/board';

/** Файл доски: записи и применённые ходы (ключи повтора, P181). */
export interface BoardFile {
  v: 1;
  entries: BoardEntry[];
  moves: { cmdId: string; at: number; created?: string[] }[];
}

/** Исход правки файла: применить (и что создано) или отказ без записи. */
export type BoardChange<R> = { ok: true; created?: string[] } | { ok: false; refusal: R };

export interface BoardStoreDeps {
  /** Дом ядра: файл — `<root>/board.json`. */
  root: string;
  /** Подмена записи — только для тестов отказов (по умолчанию атомарная замена). */
  write?: (path: string, text: string) => void;
}

export interface BoardStore {
  path: string;
  /** Копия файла; нечитаемый — `BoardStoreError`, а не пустая доска. */
  read(): BoardFile;
  /** Ход с этим `cmdId` уже применён — его запись (повтор не делает ход второй раз). */
  applied(cmdId: string): BoardFile['moves'][number] | undefined;
  /**
   * Правка под одним писателем: `change` меняет копию; `ok` — копия ложится на диск атомарно
   * вместе с ключом повтора `cmdId` (`null` — правка самого ядра, без ключа).
   */
  update<R>(
    cmdId: string | null,
    at: number,
    change: (file: BoardFile) => BoardChange<R>,
  ): BoardChange<R>;
  entry(entryId: string): BoardEntry | undefined;
  /** Забыть память и перечитать диск при следующем обращении — только для тестов краха. */
  reset(): void;
}
