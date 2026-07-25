import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { ConfigProvider } from '../../providers/types.ts';
import {
  readJsonFile,
  writeJsonFile,
  writeTextFile,
  writeBinaryFile,
  providerBackupName,
} from '../../lib/safe-io.ts';
import { archiveError, type ArchiveManifest, type ParsedArchive } from './archive.ts';
import { sha256 } from './collect.ts';
import { providerLocations } from './locations.ts';

/**
 * Разворот архива окружения на этой машине.
 *
 * Порядок жёсткий: сначала ПЛАН (что и куда легло бы, что уже такое же, что
 * отличается), пользователь отмечает записи, и только потом запись. Причина та
 * же, что и у остальных чужих форматов в панели: архив пришёл с другой машины,
 * и молча затирать им живую конфигурацию нельзя.
 *
 * Пути берутся не из архива, а вычисляются заново (`providerLocations`): архив
 * знает только номер места и путь внутри него. Место с таким номером не нашлось
 * или путь выводит за его пределы — запись помечается нерешённой и не пишется.
 */

export interface ImportPlanEntry {
  archivePath: string;
  /** Путь внутри места — как он выглядит в архиве. */
  relative: string;
  /** Куда ляжет на ЭТОЙ машине. Пусто, если место не нашлось. */
  targetPath?: string;
  /**
   * `new` — такого файла нет; `same` — байт-в-байт совпадает; `differs` — файл
   * есть и отличается; `unresolved` — некуда положить.
   */
  status: 'new' | 'same' | 'differs' | 'unresolved';
  applyMode: 'file' | 'json-merge';
  bytes: number;
  /** Ключи, чьи значения заменены меткой при экспорте. */
  redactedKeys: string[];
  /** Почему запись нерешённая. */
  problem?: string;
}

export interface ImportPlan {
  provider: { id: string; name: string };
  exportedAt: string;
  sourcePlatform: string;
  /** Куда лягут места архива на этой машине. */
  locations: { index: number; role: string; sourcePath: string; targetPath?: string }[];
  entries: ImportPlanEntry[];
  counts: { new: number; same: number; differs: number; unresolved: number };
  checklist: ArchiveManifest['checklist'];
}

export interface ImportSummary {
  written: string[];
  merged: string[];
  skipped: string[];
  backupPaths: string[];
}

/**
 * Считает план разворота. Ничего не пишет — только сравнивает содержимое архива
 * с тем, что уже лежит на диске.
 */
export function planEnvironmentImport(
  parsed: ParsedArchive,
  provider: ConfigProvider,
  override?: string,
): ImportPlan {
  assertSameProvider(parsed.manifest, provider);

  const locations = providerLocations(provider, override);
  const byIndex = new Map(locations.map((location) => [location.index, location]));

  const entries = parsed.manifest.entries.map((entry): ImportPlanEntry => {
    const base: ImportPlanEntry = {
      archivePath: entry.archivePath,
      relative: entry.relative,
      status: 'unresolved',
      applyMode: entry.applyMode,
      bytes: entry.bytes,
      redactedKeys: entry.redactedKeys,
    };

    const location = byIndex.get(entry.locationIndex);
    if (!location) {
      return { ...base, problem: `На этой машине нет места №${entry.locationIndex}.` };
    }

    let targetPath: string;
    try {
      targetPath = resolveTarget(location.path, location.kind, entry.relative);
    } catch (error) {
      return { ...base, problem: error instanceof Error ? error.message : String(error) };
    }

    const data = parsed.files.get(entry.archivePath);
    if (!data) return { ...base, problem: 'Файла нет в архиве.' };

    return { ...base, targetPath, status: compare(targetPath, data, entry.applyMode) };
  });

  return {
    provider: { id: provider.id, name: provider.name },
    exportedAt: parsed.manifest.exportedAt,
    sourcePlatform: parsed.manifest.source.platform,
    locations: parsed.manifest.locations.map((location) => ({
      index: location.index,
      role: location.role,
      sourcePath: location.sourcePath,
      targetPath: byIndex.get(location.index)?.path,
    })),
    entries,
    counts: {
      new: entries.filter((entry) => entry.status === 'new').length,
      same: entries.filter((entry) => entry.status === 'same').length,
      differs: entries.filter((entry) => entry.status === 'differs').length,
      unresolved: entries.filter((entry) => entry.status === 'unresolved').length,
    },
    checklist: parsed.manifest.checklist,
  };
}

export interface ApplyOptions {
  /** Какие записи применять (пути внутри архива). Пусто — ничего не пишем. */
  selection: string[];
  override?: string;
  backupDir?: string;
}

/**
 * Пишет выбранные записи. Каждая перезапись идёт под резервную копию, поэтому
 * неудачный импорт откатывается штатным механизмом копий панели.
 */
export function applyEnvironmentImport(
  parsed: ParsedArchive,
  provider: ConfigProvider,
  options: ApplyOptions,
): ImportSummary {
  const plan = planEnvironmentImport(parsed, provider, options.override);
  const selected = new Set(options.selection);
  const summary: ImportSummary = { written: [], merged: [], skipped: [], backupPaths: [] };

  // Сначала проверяем ВСЕ выбранные записи и только потом пишем: наполовину
  // применённый архив хуже, чем непринятый.
  const ready: { entry: ImportPlanEntry; data: Buffer }[] = [];
  for (const entry of plan.entries) {
    if (!selected.has(entry.archivePath)) continue;
    if (entry.status === 'unresolved' || !entry.targetPath) {
      throw archiveError(`Запись «${entry.archivePath}» некуда положить: ${entry.problem ?? ''}`);
    }
    const data = parsed.files.get(entry.archivePath);
    if (!data) throw archiveError(`Файла «${entry.archivePath}» нет в архиве.`);
    ready.push({ entry, data });
  }

  for (const { entry, data } of ready) {
    const target = entry.targetPath!;
    const backupName =
      provider.id === 'claude' ? basename(target) : providerBackupName(provider.id, target);
    const write = { backupDir: options.backupDir, backupName };

    if (entry.applyMode === 'json-merge') {
      const incoming = parseJson(data.toString('utf8'), entry.archivePath);
      const current = readJsonFile<Record<string, unknown>>(target, {});
      const backup = writeJsonFile(target, { ...current, ...incoming }, write);
      if (backup) summary.backupPaths.push(backup);
      summary.merged.push(target);
      continue;
    }

    // Двоичное содержимое пишем как есть; текст — через форм-сохраняющую запись,
    // чтобы не менять чужому файлу переводы строк и BOM.
    const backup = data.includes(0)
      ? writeBinaryFile(target, data, write)
      : writeTextFile(target, data.toString('utf8'), write);
    if (backup) summary.backupPaths.push(backup);
    summary.written.push(target);
  }

  for (const entry of plan.entries) {
    if (!selected.has(entry.archivePath) && entry.targetPath)
      summary.skipped.push(entry.targetPath);
  }

  return summary;
}

/** Архив одного провайдера не разворачивается в другого: форматы несовместимы. */
function assertSameProvider(manifest: ArchiveManifest, provider: ConfigProvider): void {
  if (manifest.provider.id !== provider.id) {
    throw archiveError(
      `Архив собран для провайдера «${manifest.provider.name}», а разворачивается в «${provider.name}».`,
    );
  }
}

/**
 * Куда ляжет запись. Для места-каталога — путь внутри него, с проверкой на
 * выход за пределы (`..`, абсолютный путь, подмена разделителей). Для
 * места-файла путь внутри должен совпадать с именем самого файла.
 */
function resolveTarget(locationPath: string, kind: 'dir' | 'file', relative: string): string {
  const trimmed = relative.trim();
  if (!trimmed || trimmed.includes('\0')) throw archiveError('Пустой путь записи в архиве.');

  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw archiveError(`Абсолютный путь записи запрещён: «${relative}».`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw archiveError(`Путь записи выходит за пределы места: «${relative}».`);
  }

  if (kind === 'file') {
    if (normalized !== basename(locationPath)) {
      throw archiveError(`Запись «${relative}» не совпадает с именем файла места.`);
    }
    return locationPath;
  }

  const base = resolve(locationPath);
  const target = resolve(base, ...normalized.split('/'));
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw archiveError(`Путь записи выходит за пределы места: «${relative}».`);
  }
  return target;
}

/** Сравнение с тем, что уже лежит на диске. */
function compare(
  targetPath: string,
  data: Buffer,
  applyMode: 'file' | 'json-merge',
): 'new' | 'same' | 'differs' {
  if (!existsSync(targetPath)) return 'new';
  try {
    if (statSync(targetPath).isDirectory()) return 'differs';
    const current = readFileSync(targetPath);
    if (applyMode === 'json-merge') return jsonMergeChanges(current, data) ? 'differs' : 'same';
    return sha256(current) === sha256(data) ? 'same' : 'differs';
  } catch {
    return 'differs';
  }
}

/** Изменит ли вливание ключей текущий файл (иначе показывать «отличается» незачем). */
function jsonMergeChanges(current: Buffer, incoming: Buffer): boolean {
  try {
    const existing = JSON.parse(current.toString('utf8')) as Record<string, unknown>;
    const patch = JSON.parse(incoming.toString('utf8')) as Record<string, unknown>;
    return Object.entries(patch).some(
      ([key, value]) => JSON.stringify(existing[key]) !== JSON.stringify(value),
    );
  } catch {
    return true;
  }
}

function parseJson(text: string, archivePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('не объект');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw archiveError(`Запись «${archivePath}» должна быть JSON-объектом.`);
  }
}
