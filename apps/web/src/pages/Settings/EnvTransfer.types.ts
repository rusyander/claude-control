/** Ответы маршрутов переноса окружения (`/api/env-transfer/*`). */

export interface EnvTransferChecklistItem {
  source: string;
  keys: string[];
  reason: 'redacted' | 'env-file' | 'secret-file';
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
  skipped: EnvTransferSkipped[];
  checklist: EnvTransferChecklistItem[];
}

export interface EnvTransferExportResult {
  ok: true;
  path: string;
  bytes: number;
  files: number;
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
}
