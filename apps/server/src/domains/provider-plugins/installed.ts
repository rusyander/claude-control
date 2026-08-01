import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderInstalledPlugin, ProviderPluginsInfo } from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Установленные плагины Kimi (KIMI-3) — ТОЛЬКО ЧТЕНИЕ. Ставят, включают и
 * выключают их командой `/plugins` внутри CLI, а форма реестра `installed.json`
 * не задокументирована, поэтому панель здесь ничего не пишет.
 */

/**
 * Манифест плагина Kimi. Имя файла задокументировано в двух вариантах, первый
 * приоритетнее: `<корень>/kimi.plugin.json`, затем `<корень>/.kimi-plugin/plugin.json`.
 */
const KIMI_MANIFEST_NAMES = ['kimi.plugin.json', join('.kimi-plugin', 'plugin.json')] as const;

/** Прочитать один манифест. Не найден или не разобран → плагин с `error`. */
function readInstalledPlugin(pluginsDir: string, id: string): ProviderInstalledPlugin {
  const root = join(pluginsDir, id);
  const manifestPath = KIMI_MANIFEST_NAMES.map((name) => join(root, name)).find((path) =>
    existsSync(path),
  );
  if (!manifestPath) {
    return {
      id,
      manifestPath: root,
      hasSkills: false,
      mcpServers: [],
      hookCount: 0,
      hasCommands: false,
      error: 'Манифест плагина не найден.',
    };
  }

  try {
    const raw = parseProviderJsonObject<Record<string, unknown>>(readTextFile(manifestPath));
    const ui = raw.interface;
    const sessionStart = raw.sessionStart;
    const servers = raw.mcpServers;
    const hooks = raw.hooks;

    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value : undefined;

    return {
      id,
      manifestPath,
      ...(asString(raw.name) ? { name: asString(raw.name)! } : {}),
      ...(asString(raw.version) ? { version: asString(raw.version)! } : {}),
      ...(asString(raw.description) ? { description: asString(raw.description)! } : {}),
      ...(ui && typeof ui === 'object' && asString((ui as Record<string, unknown>).displayName)
        ? { displayName: asString((ui as Record<string, unknown>).displayName)! }
        : {}),
      hasSkills: raw.skills !== undefined,
      ...(sessionStart &&
      typeof sessionStart === 'object' &&
      asString((sessionStart as Record<string, unknown>).skill)
        ? { sessionStartSkill: asString((sessionStart as Record<string, unknown>).skill)! }
        : {}),
      mcpServers:
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? Object.keys(servers as Record<string, unknown>)
          : [],
      hookCount: Array.isArray(hooks) ? hooks.length : 0,
      hasCommands: raw.commands !== undefined,
    };
  } catch (error) {
    return {
      id,
      manifestPath,
      hasSkills: false,
      mcpServers: [],
      hookCount: 0,
      hasCommands: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Сводка раздела для Kimi: список установленного из `plugins/managed/`. Панель
 * НИЧЕГО здесь не пишет — ставят, включают и выключают плагины командой
 * `/plugins` внутри CLI, а форма реестра `installed.json` не задокументирована.
 */
export function readInstalledPluginsInfo(
  target: ProviderPluginsTarget,
  base: Pick<
    ProviderPluginsInfo,
    'providerId' | 'providerName' | 'format' | 'scope' | 'pluginsDir' | 'dirExists'
  >,
): ProviderPluginsInfo {
  let installed: ProviderInstalledPlugin[] = [];
  let installedError: string | undefined;

  if (base.dirExists) {
    try {
      installed = readdirSync(target.pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readInstalledPlugin(target.pluginsDir, entry.name))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (error) {
      installedError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...base,
    sections: ['installed'],
    files: [],
    ignored: [],
    filesReadOnly: true,
    packagesPresent: false,
    packages: [],
    preservedPackages: [],
    packagesReadOnly: true,
    installed,
    ...(target.registryPath ? { installedRegistryPath: target.registryPath } : {}),
    ...(installedError ? { installedError } : {}),
  };
}
