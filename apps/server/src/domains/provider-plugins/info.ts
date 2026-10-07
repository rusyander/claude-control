import { existsSync } from 'node:fs';
import type { ProviderPluginsInfo } from '@agentdeck/contracts';
import { readPluginFilesSection } from './files.ts';
import { readInstalledPluginsInfo } from './installed.ts';
import { readQwenExtensionsInfo } from './qwen-extensions.ts';
import { readCodexPluginsInfo } from './codex-plugins.ts';
import { readPluginPackagesSection } from './packages.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Сводка раздела: файлы каталога + список npm-пакетов. Половины независимы:
 * сломанный конфиг не мешает управлять файлами, и наоборот. У Kimi раздел другой
 * — список установленного, только для чтения; у Qwen и Codex — список
 * установленного, который меняют команды самого CLI.
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
  if (target.format === 'qwen-extensions') return readQwenExtensionsInfo(target, base);
  if (target.format === 'codex-plugins') return readCodexPluginsInfo(target, base);

  return {
    ...base,
    sections: ['files', 'packages'],
    ...readPluginFilesSection(target, base.dirExists),
    ...readPluginPackagesSection(target),
    installed: [],
    installedActions: false,
    available: [],
    marketplaces: [],
    marketplaceActions: false,
  };
}
