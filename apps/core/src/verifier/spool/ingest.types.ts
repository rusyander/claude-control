import type { Fact } from '@agentdeck/contracts/core/facts';
import type { SpoolRecord } from '@agentdeck/contracts/core/records';

/**
 * Куда уходит прогон из очереди: хранилище записей (зона A) как происхождение `unattended`.
 * Ответ — номер записи; отказ с причиной (временный: файл остаётся до следующего забора); или
 * неприём (постоянный: прогону нет места в хранилище — файл уходит в `spool/bad/` с причиной).
 */
export interface SpoolSink {
  take(
    record: SpoolRecord,
  ): Promise<{ taken: string } | { refused: string } | { rejected: string }>;
}

export interface SpoolDeps {
  /** Подмена чтения каталога и файла — только для тестов отказов (P44). */
  list?: (dir: string) => Fact<string[]>;
  read?: (file: string) => Fact<Buffer>;
}

export interface SpoolOutcome {
  /** Номера записей, которые хранилище взяло (файлы сняты и прочитаны назад). */
  taken: string[];
  /** Файлы не той формы — перенесены в `spool/bad/`. */
  bad: { file: string; reason: string }[];
  /** Файлы, оставленные до следующего забора, с причиной. */
  kept: { file: string; reason: string }[];
  /** Каталог очереди не прочитан — ничего не забрано, и это не «пусто». */
  unread?: string;
}
