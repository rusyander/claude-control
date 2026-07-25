import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * Где лежит конфигурация провайдера — единый список мест, которым пользуются и
 * экспорт, и импорт переноса окружения.
 *
 * Ключевое свойство: список СЧИТАЕТСЯ ОДИНАКОВО на обеих машинах. Архив хранит
 * не абсолютные пути (на новой машине домашняя папка другая, а у Goose под
 * Windows конфиг вообще в `%APPDATA%`), а номер места и путь внутри него.
 * Импорт заново вычисляет места на своей машине и раскладывает файлы по ним.
 * Число мест не совпало — записи честно помечаются нерешёнными, а не пишутся
 * наугад.
 *
 * Источник истины по путям — `providers/catalog.ts`; здесь только сборка его
 * объявлений в один упорядоченный список. Разделы со статусом не `ready` не
 * берутся: панель их не ведёт, значит и переносить их формат мы не умеем.
 */

export interface ProviderLocation {
  /** Номер места. Он же попадает в путь внутри архива (`files/loc-0/...`). */
  index: number;
  /** Каталог обходится рекурсивно, файл кладётся целиком. */
  kind: 'dir' | 'file';
  /** Абсолютный путь НА ЭТОЙ машине. */
  path: string;
  /** Чем объявлено место — для манифеста и диагностики. */
  role: string;
}

/** Упорядоченный список мест конфигурации провайдера. */
export function providerLocations(provider: ConfigProvider, override?: string): ProviderLocation[] {
  const seen = new Set<string>();
  const locations: ProviderLocation[] = [];

  const add = (path: string | undefined, role: string, kind: 'dir' | 'file'): void => {
    if (!path) return;
    const absolute = resolve(path);
    const key = normalizeKey(absolute);
    if (seen.has(key)) return;
    // Файл внутри уже добавленного каталога отдельным местом не становится:
    // обход каталога его и так заберёт, а два места на один файл дали бы дубль.
    if (
      kind === 'file' &&
      locations.some((item) => item.kind === 'dir' && isInside(item.path, absolute))
    ) {
      return;
    }
    if (
      kind === 'dir' &&
      locations.some((item) => item.kind === 'dir' && isInside(item.path, absolute))
    ) {
      return;
    }
    seen.add(key);
    locations.push({ index: locations.length, kind, path: absolute, role });
  };

  // 1. Объявленные корни. Обычно это каталог, но у Aider `configLocations`
  //    перечисляет ФАЙЛЫ в домашней папке — обходить её целиком нельзя.
  for (const path of provider.configLocations?.(override) ?? []) {
    add(path, 'config', probeKind(path));
  }

  // 2. Claude — единственный, чьи MCP-серверы лежат ВНЕ каталога конфигурации
  //    (`~/.claude.json`) и не объявлены через `mcpConfig`: этот раздел у него
  //    свой, богатый, и универсальным адаптером не обслуживается. Без явной
  //    строки архив Claude уехал бы без MCP-серверов — то есть без половины
  //    смысла переноса.
  if (provider.id === 'claude') add(provider.paths(override).mcpConfig, 'mcp', 'file');

  // 3. Файлы разделов остальных провайдеров. Почти всегда лежат внутри корня и
  //    отсеиваются как дубль; остаются те, что вне его.
  const { capabilities } = provider;
  if (capabilities.globalInstructions === 'ready') {
    add(provider.instructionsFile?.(override), 'instructions', 'file');
    add(provider.instructionsList?.path(override), 'instructionsList', 'file');
    add(provider.instructionsRules?.dir(override), 'instructionsRules', 'dir');
  }
  if (capabilities.mcp === 'ready') add(provider.mcpConfig?.path(override), 'mcp', 'file');
  if (capabilities.env === 'ready') add(provider.envConfig?.path(override), 'env', 'file');
  if (capabilities.permissions === 'ready') {
    add(provider.permissionsConfig?.path(override), 'permissions', 'file');
  }
  if (capabilities.hooks === 'ready') add(provider.hooksConfig?.path(override), 'hooks', 'file');
  if (capabilities.plugins === 'ready') {
    // Конфиг с массивом `plugin` есть только у OpenCode; у Kimi плагины —
    // каталог установленного, отдельного файла со списком у панели нет.
    add(provider.pluginsConfig?.configPath?.(override), 'pluginsConfig', 'file');
    add(provider.pluginsConfig?.dir(override), 'plugins', 'dir');
  }
  if (capabilities.skills === 'ready') add(provider.skillsConfig?.dir(override), 'skills', 'dir');

  return locations;
}

/**
 * Каталог это или файл. Существующий путь спрашиваем у файловой системы;
 * несуществующий считаем каталогом — все объявленные корни это каталоги, а
 * файловые места (Aider) на момент экспорта либо есть, либо переносить нечего.
 */
function probeKind(path: string): 'dir' | 'file' {
  try {
    if (!existsSync(path)) return 'dir';
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'dir';
  }
}

/** Лежит ли `candidate` внутри каталога `dir` (сравнение по нормализованному пути). */
export function isInside(dir: string, candidate: string): boolean {
  const base = normalizeKey(resolve(dir));
  const target = normalizeKey(resolve(candidate));
  return target === base || target.startsWith(`${base}${sep}`);
}

/** Ключ сравнения путей: Windows не различает регистр, Linux различает. */
function normalizeKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
