/** Ответы маршрутов переноса окружения (`/api/env-transfer/*`). */

export interface EnvTransferChecklistItem {
  source: string;
  keys: string[];
  /** `panel-key` — ключ контура: он не лежал в файлах и переносу не подлежит. */
  reason: 'redacted' | 'env-file' | 'secret-file' | 'panel-key';
}

/** Контур в архиве: настройка едет, ключ остаётся на прежней машине. */
export interface EnvTransferPlatformEntry {
  id: string;
  title: string;
  driver: string;
  baseUrl: string;
  status: 'new' | 'same' | 'differs';
  hasToken: boolean;
  notes: string[];
}

export interface EnvTransferPlatformsPlan {
  entries: EnvTransferPlatformEntry[];
  gateway?: { enabled: boolean; port: number; forceStream: boolean };
  problem?: string;
}

/**
 * Правка промпта в архиве. Встроенных текстов здесь нет вовсе: они приезжают
 * вместе с панелью, и архив везёт только разницу.
 */
export interface EnvTransferPromptEntry {
  id: string;
  status: 'new' | 'same' | 'differs';
  bytes: number;
  /** Промпта с таким идентификатором в этой панели нет — записать его некуда. */
  unknown: boolean;
}

export interface EnvTransferPromptsPlan {
  entries: EnvTransferPromptEntry[];
  problem?: string;
}

export interface EnvTransferSkipped {
  sourcePath: string;
  reason: string;
}

export interface EnvTransferPreview {
  provider: { id: string; name: string };
  locations: { index: number; kind: 'dir' | 'file'; role: string; path: string; exists: boolean }[];
  files: number;
  bytes: number;
  /** Контуры панели, которые уедут вместе с конфигурацией CLI. */
  platforms: { id: string; title: string; baseUrl: string }[];
  skipped: EnvTransferSkipped[];
  checklist: EnvTransferChecklistItem[];
}

export interface EnvTransferExportResult {
  ok: true;
  path: string;
  bytes: number;
  files: number;
  /** Сколько контуров легло в архив. */
  platforms: number;
  skipped: EnvTransferSkipped[];
  checklist: EnvTransferChecklistItem[];
}

export type EnvTransferEntryStatus = 'new' | 'same' | 'differs' | 'unresolved';

export interface EnvTransferPlanEntry {
  archivePath: string;
  relative: string;
  targetPath?: string;
  status: EnvTransferEntryStatus;
  applyMode: 'file' | 'json-merge';
  bytes: number;
  redactedKeys: string[];
  problem?: string;
}

export interface EnvTransferPlan {
  provider: { id: string; name: string };
  exportedAt: string;
  sourcePlatform: string;
  locations: { index: number; role: string; sourcePath: string; targetPath?: string }[];
  entries: EnvTransferPlanEntry[];
  counts: { new: number; same: number; differs: number; unresolved: number };
  checklist: EnvTransferChecklistItem[];
  /** Секции нет — контуров в архиве не было. */
  platforms?: EnvTransferPlatformsPlan;
  /** Секции нет — на прежней машине не правили ни одного промпта. */
  prompts?: EnvTransferPromptsPlan;
}
