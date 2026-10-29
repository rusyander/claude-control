import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckKey,
  CheckRecord,
  RecordId,
  RecordReader,
} from '@agentdeck/contracts/core/records';

/** То, что пишущий даёт хранилищу: всё, кроме имени, версии, вывода и подписи — их ставит оно. */
export type RecordDraft = Omit<CheckRecord, 'v' | 'id' | 'log' | 'sig'>;

/** Файловые операции хранилища (`platform/git` по умолчанию); подменяются в тестах отказов P44. */
export interface StoreIo {
  read(path: string): Fact<Buffer>;
  list(dir: string): Fact<string[]>;
  createOnce(path: string, data: Uint8Array): 'created' | 'exists';
}

/** Файл, пропущенный при чтении ключа: битый, чужой подписи или чужой версии (D§6) — с причиной. */
export interface SkippedRecord {
  file: string;
  why: string;
}

export interface KeyScan {
  records: CheckRecord[];
  skipped: SkippedRecord[];
}

export interface RecordStoreOptions {
  /** `<common>/agentdeck-verify/v2` (`storeRoot`). */
  root: string;
  /** Ключ подписи из дома ядра (`loadVerifyKey`). */
  key: Uint8Array;
  io?: StoreIo;
}

export interface RecordStore extends RecordReader {
  /** Записи ключа и пропущенные файлы с причинами — для журнала (D§6: «пропущено и названо»). */
  scan(key: CheckKey): Fact<KeyScan>;
  /**
   * Записи проверки и единицы по всем ключам (старые первыми) — для выученного срока прогона.
   * Записи до указателя в нём не видны: срок тогда учится по ключу запроса.
   */
  history(checkId: string, unit: string): Fact<CheckRecord[]>;
  /** Записать один раз: вывод первым, затем запись жёсткой ссылкой; имя `<ключ>.<попытка>`. */
  /** `logTruncated` — вывод уже обрезал пишущий (прокладка захвата), запись не скажет «целый». */
  write(draft: RecordDraft, log: string | Uint8Array, logTruncated?: boolean): Fact<RecordId>;
  /** Файл сжатого вывода записи (`.log.gz`) — повтор прокладкой захвата читает его сам. */
  logPath(id: RecordId): string;
  root: string;
}
