import type { ProviderLocation } from '../locations.ts';

export interface CollectedFile {
  /** Путь внутри архива (`files/loc-0/settings.json`). */
  archivePath: string;
  /** Номер места из `providerLocations` и путь внутри него. */
  locationIndex: number;
  relative: string;
  /** Абсолютный путь на машине-источнике — только для чтения человеком и моделью. */
  sourcePath: string;
  /** Как применять на новой машине. */
  applyMode: 'file' | 'json-merge';
  /** Какие ключи вливать при `json-merge`. */
  mergeKeys?: string[];
  bytes: number;
  sha256: string;
  /** Ключи, значения которых заменены меткой. */
  redactedKeys: string[];
  data: Buffer;
}

export interface SkippedFile {
  sourcePath: string;
  reason: 'secret' | 'too-large' | 'excluded' | 'unreadable' | 'archive-full';
}

export interface ChecklistItem {
  /** Где это было на прежней машине. */
  source: string;
  /** Имена ключей без значений. */
  keys: string[];
  /**
   * `panel-key` отличается от остальных трёх происхождением: этот секрет не
   * лежал ни в каком файле прежней машины и потому не мог быть ни вырезан, ни
   * пропущен — ключ контура живёт в зашифрованном хранилище панели. В чек-лист
   * он попадает не как «мы это не взяли», а как «этого в архиве нет по
   * устройству, введите руками».
   */
  reason: 'redacted' | 'env-file' | 'secret-file' | 'panel-key';
}

export interface CollectResult {
  locations: ProviderLocation[];
  files: CollectedFile[];
  skipped: SkippedFile[];
  checklist: ChecklistItem[];
  totalBytes: number;
}
