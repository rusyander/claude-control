import type { ChecklistItem, CollectResult } from './collect.ts';

/**
 * Опись архива переноса окружения. Вынесена из `archive.ts` отдельно: пояснение
 * (`readme.ts`) описывает опись, а сборщик архива зовёт пояснение — общий тип в
 * своём модуле разрывает эту петлю.
 */

export interface ManifestLocation {
  index: number;
  kind: 'dir' | 'file';
  role: string;
  /** Путь на машине-источнике. Импорт его НЕ использует — только показывает. */
  sourcePath: string;
}

export interface ManifestEntry {
  archivePath: string;
  locationIndex: number;
  relative: string;
  sourcePath: string;
  applyMode: 'file' | 'json-merge';
  mergeKeys?: string[];
  bytes: number;
  sha256: string;
  redactedKeys: string[];
}

export interface ManifestSkipped {
  sourcePath: string;
  reason: string;
}

export interface ArchiveManifest {
  kind: string;
  formatVersion: number;
  exportedAt: string;
  provider: { id: string; name: string; status: string };
  source: { platform: string };
  locations: ManifestLocation[];
  entries: ManifestEntry[];
  skipped: ManifestSkipped[];
  /** Что придётся ввести руками: секреты в архив не кладутся. */
  checklist: ChecklistItem[];
}

export interface BuiltArchive {
  manifest: ArchiveManifest;
  zip: Buffer;
  collected: CollectResult;
}
