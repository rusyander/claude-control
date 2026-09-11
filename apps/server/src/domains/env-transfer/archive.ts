import type { ConfigProvider } from '../../providers/types.ts';
import { createZip, readZip, type ZipEntry } from '../../lib/zip.ts';
import { collectProviderFiles, sha256, type ChecklistItem } from './collect.ts';
import {
  panelPlatformsChecklist,
  panelPlatformsFile,
  PANEL_PLATFORMS_PATH,
  type PanelPlatformsDocument,
} from './platforms.ts';
import { buildArchiveReadme } from './readme.ts';
import type {
  ArchiveManifest,
  BuiltArchive,
  ManifestEntry,
  ManifestLocation,
  ManifestPanel,
  ManifestSkipped,
} from './archive.types.ts';

/**
 * Архив переноса окружения: опись (`MANIFEST.json`), пояснение для человека и
 * модели (`README.md`) и сами файлы конфигурации в `files/loc-<номер>/…`.
 *
 * Абсолютных путей в раскладке нет намеренно: они годятся только для чтения
 * («вот где это лежало»), а раскладывать файлы на новой машине надо по её
 * собственным путям — по номеру места (`locations.ts`) и пути внутри него.
 */

/** Версия формата. Растёт при несовместимом изменении раскладки архива. */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Метка, по которой архив узнаётся среди прочих zip. */
export const ARCHIVE_KIND = 'agentdeck-environment';

export const MANIFEST_PATH = 'MANIFEST.json';
export const README_PATH = 'README.md';

export type {
  ManifestLocation,
  ManifestEntry,
  ManifestPanel,
  ManifestSkipped,
  ArchiveManifest,
  BuiltArchive,
} from './archive.types.ts';

/**
 * Собирает архив окружения провайдера. `exportedAt` приходит извне (запрос или
 * часы ОС), чтобы одинаковый вход давал одинаковый архив в тестах.
 */
export function buildEnvironmentArchive(
  provider: ConfigProvider,
  exportedAt: string,
  override?: string,
  panel?: PanelPlatformsDocument,
): BuiltArchive {
  const collected = collectProviderFiles(provider, override);

  // Секция контуров кладётся ТОЛЬКО когда контуры есть: пустой файл в архиве
  // читался бы как «контуры были и не поехали».
  const panelPlatforms = panel?.platforms ?? [];
  const panelData = panelPlatforms.length > 0 && panel ? panelPlatformsFile(panel) : undefined;
  const panelEntry: ManifestPanel | undefined = panelData
    ? {
        archivePath: PANEL_PLATFORMS_PATH,
        bytes: panelData.length,
        sha256: sha256(panelData),
        platforms: panelPlatforms.map((platform) => ({
          id: platform.id,
          title: platform.title,
          driver: platform.driver,
          baseUrl: platform.baseUrl,
        })),
      }
    : undefined;

  const manifest: ArchiveManifest = {
    kind: ARCHIVE_KIND,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportedAt,
    provider: { id: provider.id, name: provider.name, status: provider.status },
    source: { platform: process.platform },
    locations: collected.locations.map((location) => ({
      index: location.index,
      kind: location.kind,
      role: location.role,
      sourcePath: location.path,
    })),
    entries: collected.files.map((file) => ({
      archivePath: file.archivePath,
      locationIndex: file.locationIndex,
      relative: file.relative,
      sourcePath: file.sourcePath,
      applyMode: file.applyMode,
      ...(file.mergeKeys ? { mergeKeys: file.mergeKeys } : {}),
      bytes: file.bytes,
      sha256: file.sha256,
      redactedKeys: file.redactedKeys,
    })),
    skipped: collected.skipped.map((item) => ({
      sourcePath: item.sourcePath,
      reason: item.reason,
    })),
    checklist: [...collected.checklist, ...panelPlatformsChecklist(panelPlatforms)],
    ...(panelEntry ? { panel: panelEntry } : {}),
  };

  const entries: ZipEntry[] = [
    { path: MANIFEST_PATH, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: README_PATH, data: Buffer.from(buildArchiveReadme(manifest), 'utf8') },
    ...collected.files.map((file) => ({ path: file.archivePath, data: file.data })),
    ...(panelData ? [{ path: PANEL_PLATFORMS_PATH, data: panelData }] : []),
  ];

  const stamp = new Date(exportedAt);
  return {
    manifest,
    zip: createZip(entries, Number.isNaN(stamp.getTime()) ? new Date() : stamp),
    collected,
  };
}

/** Имя файла архива: провайдер и дата, без двоеточий (Windows их не примет). */
export function archiveFileName(providerId: string, exportedAt: string): string {
  const stamp = exportedAt.replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `agentdeck-${providerId}-${stamp}.zip`;
}

export interface ParsedArchive {
  manifest: ArchiveManifest;
  files: Map<string, Buffer>;
}

/**
 * Разбирает архив и проверяет опись. Архив приходит с ЧУЖОЙ машины, поэтому
 * проверяется каждое поле: раскладка по номерам мест превращается в записи на
 * диск, и подсунутая опись не должна увести запись за пределы конфигурации.
 */
export function parseEnvironmentArchive(zip: Buffer): ParsedArchive {
  const files = new Map<string, Buffer>();
  for (const entry of readZip(zip)) files.set(entry.path, entry.data);

  const rawManifest = files.get(MANIFEST_PATH);
  if (!rawManifest) throw archiveError('В архиве нет MANIFEST.json — это не архив окружения.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest.toString('utf8'));
  } catch {
    throw archiveError('MANIFEST.json повреждён: не разбирается как JSON.');
  }
  if (!isRecord(parsed)) throw archiveError('MANIFEST.json должен быть объектом.');

  if (parsed.kind !== ARCHIVE_KIND) {
    throw archiveError('Этот архив собран не панелью — в описи другой тип.');
  }
  if (typeof parsed.formatVersion !== 'number') {
    throw archiveError('В описи нет числового formatVersion.');
  }
  if (parsed.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw archiveError(
      `Версия формата архива (${parsed.formatVersion}) новее поддерживаемой (${ARCHIVE_FORMAT_VERSION}).`,
    );
  }

  const provider = parsed.provider;
  if (!isRecord(provider) || typeof provider.id !== 'string' || !provider.id.trim()) {
    throw archiveError('В описи не указан провайдер.');
  }

  if (!Array.isArray(parsed.locations)) throw archiveError('В описи нет списка мест.');
  if (!Array.isArray(parsed.entries)) throw archiveError('В описи нет списка файлов.');

  const locations = parsed.locations.map(parseLocation);
  const entries = parsed.entries.map((entry, index) => parseEntry(entry, index, files));
  const panel = parsePanelSection(parsed.panel, files);

  return {
    manifest: {
      kind: ARCHIVE_KIND,
      formatVersion: parsed.formatVersion,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      provider: {
        id: provider.id,
        name: typeof provider.name === 'string' ? provider.name : provider.id,
        status: typeof provider.status === 'string' ? provider.status : 'experimental',
      },
      source: {
        platform:
          isRecord(parsed.source) && typeof parsed.source.platform === 'string'
            ? parsed.source.platform
            : 'unknown',
      },
      locations,
      entries,
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter(isSkipped) : [],
      checklist: Array.isArray(parsed.checklist) ? parsed.checklist.filter(isChecklistItem) : [],
      ...(panel ? { panel } : {}),
    },
    files,
  };
}

/**
 * Секция контуров из описи. Отсутствует — значит контуров на прежней машине не
 * было; заявлена, но файла в архиве нет — говорим об этом вслух: молча
 * потерянная настройка контура выглядела бы как «панель ничего не перенесла».
 */
function parsePanelSection(value: unknown, files: Map<string, Buffer>): ManifestPanel | undefined {
  if (!isRecord(value)) return undefined;

  const archivePath = typeof value.archivePath === 'string' ? value.archivePath : '';
  if (!archivePath) throw archiveError('В описи есть секция контуров без пути к файлу.');
  if (!files.has(archivePath)) {
    throw archiveError(`Секция контуров «${archivePath}» есть в описи, но отсутствует в архиве.`);
  }

  return {
    archivePath,
    bytes: typeof value.bytes === 'number' ? value.bytes : 0,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
    platforms: Array.isArray(value.platforms) ? value.platforms.filter(isPanelPlatform) : [],
  };
}

function isPanelPlatform(value: unknown): value is ManifestPanel['platforms'][number] {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.driver === 'string' &&
    typeof value.baseUrl === 'string'
  );
}

function parseLocation(value: unknown, index: number): ManifestLocation {
  if (!isRecord(value) || (value.kind !== 'dir' && value.kind !== 'file')) {
    throw archiveError(`Место #${index + 1} в описи задано неверно.`);
  }
  return {
    index: typeof value.index === 'number' ? value.index : index,
    kind: value.kind,
    role: typeof value.role === 'string' ? value.role : 'config',
    sourcePath: typeof value.sourcePath === 'string' ? value.sourcePath : '',
  };
}

function parseEntry(value: unknown, index: number, files: Map<string, Buffer>): ManifestEntry {
  if (
    !isRecord(value) ||
    typeof value.archivePath !== 'string' ||
    typeof value.relative !== 'string' ||
    typeof value.locationIndex !== 'number'
  ) {
    throw archiveError(`Файл #${index + 1} в описи задан неверно.`);
  }
  if (!files.has(value.archivePath)) {
    throw archiveError(`Файл «${value.archivePath}» есть в описи, но отсутствует в архиве.`);
  }

  const applyMode = value.applyMode === 'json-merge' ? 'json-merge' : 'file';
  const mergeKeys =
    applyMode === 'json-merge' && Array.isArray(value.mergeKeys)
      ? value.mergeKeys.filter((key): key is string => typeof key === 'string')
      : undefined;

  return {
    archivePath: value.archivePath,
    locationIndex: value.locationIndex,
    relative: value.relative,
    sourcePath: typeof value.sourcePath === 'string' ? value.sourcePath : '',
    applyMode,
    ...(mergeKeys ? { mergeKeys } : {}),
    bytes: typeof value.bytes === 'number' ? value.bytes : 0,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
    redactedKeys: Array.isArray(value.redactedKeys)
      ? value.redactedKeys.filter((key): key is string => typeof key === 'string')
      : [],
  };
}

function isSkipped(value: unknown): value is ManifestSkipped {
  return (
    isRecord(value) && typeof value.sourcePath === 'string' && typeof value.reason === 'string'
  );
}

function isChecklistItem(value: unknown): value is ChecklistItem {
  return isRecord(value) && typeof value.source === 'string' && Array.isArray(value.keys);
}

export function archiveError(message: string): Error {
  return Object.assign(new Error(message), { code: 'invalid_archive' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
