import { existsSync } from 'node:fs';
import type { ProviderPluginsInfo } from '@claude-control/contracts';
import { readPluginFilesSection } from './files.ts';
import { readInstalledPluginsInfo } from './installed.ts';
import { readPluginPackagesSection } from './packages.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Сводка раздела: файлы каталога + список npm-пакетов. Половины независимы:
 * сломанный конфиг не мешает управлять файлами, и наоборот. У Kimi раздел другой
 * — список установленного, только для чтения.
 */
export function readProviderPluginsInfo(target: ProviderPluginsTarget): ProviderPluginsInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    pluginsDir: target.pluginsDir,
    dirExists: existsSync(target.pluginsDir),
    ...(target.configPath ? { configPath: target.configPath } : {}),
  };

  if (target.format === 'kimi-plugins') return readInstalledPluginsInfo(target, base);

  return {
    ...base,
    sections: ['files', 'packages'],
    ...readPluginFilesSection(target, base.dirExists),
    ...readPluginPackagesSection(target),
    installed: [],
  };
}
