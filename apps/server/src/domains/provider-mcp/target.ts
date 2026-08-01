import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { providerBackupName, providerProjectBackupName } from '../../lib/safe-io.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import type { ProviderMcpSettingsSource, ProviderMcpTarget } from './types.ts';

/**
 * Цель универсального MCP-раздела активного провайдера — или `undefined`, если он
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `mcp` = `ready`
 * И задан `mcpConfig` (Codex/Gemini/Cursor/OpenCode). Claude сюда не попадает (у
 * него нет `mcpConfig`) — он на своих роутах. Fail-closed.
 */
export function resolveProviderMcpTarget(
  store: ProviderMcpSettingsSource,
): ProviderMcpTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.mcp !== 'ready' || !provider.mcpConfig) return undefined;

  const override = store.getSettings().claudeDirOverride;
  const filePath = provider.mcpConfig.path(override);
  return {
    provider,
    format: provider.mcpConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
    jsonHttpUrlKey: provider.mcpConfig.jsonHttpUrlKey ?? 'httpUrl',
    blockDir: provider.mcpConfig.blockDir?.(override),
  };
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное `<id>-<basename>`. */
export function backupNameOf(target: ProviderMcpTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Имя копии для файла-блока. Уровень наследуется от цели: у проектной цели
 * задан свой `backupName` (`<id>-project-…`), значит и блок проектный —
 * иначе копии проекта делили бы ротацию с глобальными.
 */
export function blockBackupNameOf(target: ProviderMcpTarget, blockPath: string): string {
  return target.backupName
    ? providerProjectBackupName(target.provider.id, blockPath)
    : providerBackupName(target.provider.id, blockPath);
}
