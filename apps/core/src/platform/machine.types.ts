/** Факты машины (04:114-117, 09 P106): место на диске, память, доступ к папке репозитория. */

export interface DiskSpace {
  freeBytes: number; // доступно непривилегированному процессу (`bavail`)
  totalBytes: number;
}

export interface MemSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Порог диска (04:115): по умолчанию 10 ГБ или 5 % — что меньше (на маленьком томе 10 ГБ — почти всё). */
export interface DiskThreshold {
  minBytes: number;
  minFraction: number;
}

/** Порог памяти: ниже — слоты сессий и проверок снижаются для новых запусков (04:116). */
export interface MemThreshold {
  minBytes: number;
  minFraction: number;
}

export type DiskVerdict =
  | { kind: 'ok'; free: DiskSpace }
  | { kind: 'low'; free: DiskSpace; thresholdBytes: number }
  | { kind: 'doubt'; reason: string }; // класс `machine.disk`: unknown → run (не блокирует, названо)

export type MemVerdict =
  | { kind: 'ok'; free: MemSpace }
  | { kind: 'low'; free: MemSpace; thresholdBytes: number }
  | { kind: 'doubt'; reason: string };

/** Ввод-вывод фактов машины — подменяется в тестах отказов (тайм-аут, ENOENT, EPERM, мусор). */
export interface MachineIo {
  statfs(
    path: string,
  ): Promise<{ bavail: number | bigint; blocks: number | bigint; bsize: number | bigint }>;
  memory(): { free: number; total: number };
  /** Есть ли путь — `false` только на ENOENT (единственный законный `absent`). */
  exists(path: string): Promise<boolean>;
  /** Чтение каталога репозитория — то самое чтение, которое TCC на macOS режет EPERM. */
  readdir(path: string): Promise<string[]>;
}
