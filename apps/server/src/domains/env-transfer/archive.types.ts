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

/**
 * Опись секции контуров. Только опознавательные поля: сама настройка лежит
 * рядом файлом (`panel/platforms.json`), и дублировать её в описи значило бы
 * завести второй источник истины, который однажды разойдётся с первым.
 */
export interface ManifestPanel {
  archivePath: string;
  bytes: number;
  sha256: string;
  platforms: { id: string; title: string; driver: string; baseUrl: string }[];
}

/**
 * Опись секции промптов. Только идентификаторы и размеры: тексты лежат рядом
 * файлом (`panel/prompts.json`), и держать их ещё и в описи значило бы завести
 * второй источник истины — тот же довод, что и у секции контуров.
 */
export interface ManifestPanelPrompts {
  archivePath: string;
  bytes: number;
  sha256: string;
  prompts: { id: string; bytes: number }[];
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
  /**
   * Контуры панели — настройка без ключа. Поля нет вовсе, если контуров на
   * машине-источнике не было: пустая секция в описи читалась бы как «контуры
   * были, но не поехали».
   */
  panel?: ManifestPanel;
  /**
   * Правки промптов. Поля нет вовсе, если человек не правил ни одного: пустая
   * секция читалась бы как «правки были, но не поехали».
   */
  panelPrompts?: ManifestPanelPrompts;
}

export interface BuiltArchive {
  manifest: ArchiveManifest;
  zip: Buffer;
  collected: CollectResult;
}
