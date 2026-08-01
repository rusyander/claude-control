import { basename } from 'node:path';
import type { ProviderPluginsInfo } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  applyOpencodePlugins,
  isOpencodePluginPackage,
  readOpencodePlugins,
} from '../../lib/opencode-plugin.ts';
import { requireConfigPath } from './paths.ts';
import type { ProviderPluginsTarget, RawOpencodeConfig } from './types.ts';

/** Половина сводки, отвечающая за npm-список (`plugin` в `opencode.json`). */
type PluginPackagesSection = Pick<
  ProviderPluginsInfo,
  'packagesPresent' | 'packages' | 'preservedPackages' | 'packagesReadOnly'
> &
  Partial<Pick<ProviderPluginsInfo, 'packagesError'>>;

/**
 * Массив `plugin` из конфига. Файл не разобран → список только для чтения
 * (fail-closed), файловая половина раздела от этого не страдает.
 */
export function readPluginPackagesSection(target: ProviderPluginsTarget): PluginPackagesSection {
  const text = readTextFile(requireConfigPath(target));
  const empty = {
    packagesPresent: false,
    packages: [] as string[],
    preservedPackages: [] as ProviderPluginsInfo['preservedPackages'],
  };
  if (!text.trim()) return { ...empty, packagesReadOnly: false };

  try {
    const config = parseProviderJsonObject<RawOpencodeConfig>(text);
    const state = readOpencodePlugins(config.plugin);
    return {
      packagesPresent: state.present,
      packages: state.packages,
      preservedPackages: state.preserved,
      packagesReadOnly: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, packagesReadOnly: true, ...(message ? { packagesError: message } : {}) };
  }
}

/**
 * Разобрать черновик списка npm-плагинов. Отклоняем: не массив, не строки, имя с
 * пробелом/кавычкой/пустое, дубликаты (в файле они молча остались бы обоими и
 * запутали бы пользователя).
 */
export function parseProviderPluginPackagesDraft(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as Record<string, unknown>).packages;
  if (!Array.isArray(raw) || raw.length > 200) return undefined;

  const seen = new Set<string>();
  const packages: string[] = [];
  for (const item of raw) {
    if (!isOpencodePluginPackage(item)) return undefined;
    if (seen.has(item)) return undefined;
    seen.add(item);
    packages.push(item);
  }
  return packages;
}

/**
 * Проекция «всё, кроме ведомых панелью строковых записей `plugin`». По ней
 * результат сверяется с оригиналом: изменился любой чужой ключ файла или любая
 * запись расширенной формы — запись отменяется.
 */
function otherKeysProjection(config: RawOpencodeConfig): string {
  const rest: Record<string, unknown> = { ...config };

  if (Array.isArray(config.plugin)) {
    const kept = config.plugin.filter((item) => !(typeof item === 'string' && item.trim()));
    if (kept.length > 0) rest.plugin = kept;
    else delete rest.plugin;
  }

  return stableJson(rest);
}

/**
 * Записать список npm-плагинов, поменяв ТОЛЬКО ключ `plugin`. Записи расширенной
 * формы сохраняются, пустой результат УДАЛЯЕТ ключ (а не пишет `[]`). Файл не
 * разбирается → `UnrecognizedFormatError` (маршрут 422, файл не тронут).
 */
export function saveProviderPluginPackages(
  target: ProviderPluginsTarget,
  packages: string[],
  backupDir: string | undefined,
): string | undefined {
  // Двойная страховка: даже если сюда попало кривое имя, в файл оно не уйдёт.
  for (const name of packages) {
    if (!isOpencodePluginPackage(name)) throw new UnrecognizedFormatError();
  }

  const configPath = requireConfigPath(target);
  const text = readTextFile(configPath);
  const original: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};

  const next = applyOpencodePlugins(config.plugin, packages);
  if (next) config.plugin = next;
  else delete config.plugin;

  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, список совпал с намерением, прочие
  // ключи файла и записи расширенной формы целы.
  const parsed = parseProviderJsonObject<RawOpencodeConfig>(serialized);
  const check = readOpencodePlugins(parsed.plugin);
  if (stableJson(check.packages) !== stableJson(packages)) throw new UnrecognizedFormatError();
  if (otherKeysProjection(original) !== otherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(configPath, serialized, {
    backupDir,
    backupName: `${target.backupPrefix}${basename(configPath)}`,
  });
}
