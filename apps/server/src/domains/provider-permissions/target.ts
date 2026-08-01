import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getActiveProvider } from '../../providers/registry.ts';
import { providerBackupName } from '../../lib/safe-io.ts';
import type { ProviderPermissionsSettingsSource, ProviderPermissionsTarget } from './types.ts';

/** Имя копии для этой цели: своё, если задано, иначе стандартное `<id>-<basename>`. */
export function backupNameOf(target: ProviderPermissionsTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель универсального раздела прав активного провайдера — или `undefined`, если он
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `permissions` =
 * `ready` И задан `permissionsConfig` (Codex, Gemini, OpenCode). Claude сюда не
 * попадает (у него нет `permissionsConfig`) — он на своих роутах. Fail-closed.
 */
export function resolveProviderPermissionsTarget(
  store: ProviderPermissionsSettingsSource,
): ProviderPermissionsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.permissions !== 'ready' || !provider.permissionsConfig)
    return undefined;

  const override = store.getSettings().claudeDirOverride;
  const filePath = provider.permissionsConfig.path(override);
  return {
    provider,
    format: provider.permissionsConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
    toolPermissionsPath: provider.permissionsConfig.readOnlyToolPermissionsPath?.(override),
  };
}
