import { getActiveProvider } from '../../providers/registry.ts';
import { resolveInsideSectionDir, toClientRelative } from '../../lib/section-fs.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { UnsafePluginPathError } from './errors.ts';
import type { ProviderPluginsSettingsSource, ProviderPluginsTarget } from './types.ts';

/**
 * Расширения файлов-плагинов, которые OpenCode загружает («JavaScript or
 * TypeScript files»). `.mjs` включён как обычная форма ES-модуля JS.
 * Списка «на глаз» не расширяем: чего нет в документации, того панель не пишет.
 */
export const OPENCODE_PLUGIN_EXTENSIONS = ['.js', '.ts', '.mjs'] as const;

/**
 * Цель глобального раздела плагинов — или `undefined`, если активный провайдер
 * его не поддерживает (маршрут ответит 4xx). Поддержан, только когда `plugins` =
 * `ready` И задан `pluginsConfig`. Claude сюда не попадает.
 */
export function resolveProviderPluginsTarget(
  store: ProviderPluginsSettingsSource,
): ProviderPluginsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.plugins !== 'ready' || !provider.pluginsConfig) return undefined;

  const override = store.getSettings().claudeDirOverride;
  const config = provider.pluginsConfig;
  return {
    provider,
    format: config.format,
    scope: 'global',
    pluginsDir: config.dir(override),
    ...(config.configPath ? { configPath: config.configPath(override) } : {}),
    ...(config.registryPath ? { registryPath: config.registryPath(override) } : {}),
    backupPrefix: `${provider.id}-`,
  };
}

/** Конфигурация с массивом `plugin` есть только у OpenCode — иначе это ошибка вызова. */
export function requireConfigPath(target: ProviderPluginsTarget): string {
  if (!target.configPath) throw new UnrecognizedFormatError();
  return target.configPath;
}

// --- Безопасность путей ------------------------------------------------------

/** Расширение файла из белого списка (сравнение без учёта регистра). */
export function hasPluginExtension(name: string): string | undefined {
  const lower = name.toLowerCase();
  return OPENCODE_PLUGIN_EXTENSIONS.find(
    (extension) => lower.endsWith(extension) && lower.length > extension.length,
  );
}

/**
 * Разрешить относительный путь файла плагина ВНУТРИ каталога плагинов. Сама
 * защита — общая (`lib/section-fs.ts`), здесь только своё: класс отказа и правило
 * имени — расширение из белого списка.
 */
export function resolvePluginPath(target: ProviderPluginsTarget, rawPath: string): string {
  return resolveInsideSectionDir(target.pluginsDir, rawPath, {
    fail: (path, detail) => new UnsafePluginPathError(path, detail),
    outsideDetail: 'путь выходит за пределы каталога плагинов.',
    checkSegments: (segments, value) => {
      const name = segments[segments.length - 1]!;
      if (!hasPluginExtension(name)) {
        throw new UnsafePluginPathError(
          value,
          `файл плагина обязан оканчиваться на ${OPENCODE_PLUGIN_EXTENSIONS.join(', ')}.`,
        );
      }
    },
  });
}

/** Путь относительно каталога плагинов в клиентской форме (разделитель `/`). */
export function toRelative(target: ProviderPluginsTarget, fullPath: string): string {
  return toClientRelative(target.pluginsDir, fullPath);
}

/** Имя резервной копии файла плагина: `<id>[-project-]<путь с «-» вместо «/»>`. */
export function pluginBackupName(target: ProviderPluginsTarget, fullPath: string): string {
  return `${target.backupPrefix}${toRelative(target, fullPath).split('/').join('-')}`;
}
