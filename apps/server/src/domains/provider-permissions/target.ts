import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getActiveProvider } from '../../providers/registry.ts';
import { providerBackupName } from '../../lib/safe-io.ts';
import type { ConfigProvider } from '../../providers/types.ts';
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
  return resolveProviderPermissionsTargetFor(
    getActiveProvider(store),
    store.getSettings().claudeDirOverride,
  );
}

/**
 * То же самое для ЯВНО названного провайдера — не обязательно активного. Нужно
 * переносу среды (`domains/portability/`): паспорт собирается для любого
 * установленного CLI. Условие поддержки и построение цели те же самые.
 */
export function resolveProviderPermissionsTargetFor(
  provider: ConfigProvider,
  override?: string,
): ProviderPermissionsTarget | undefined {
  if (provider.capabilities.permissions !== 'ready' || !provider.permissionsConfig)
    return undefined;

  const filePath = provider.permissionsConfig.path(override);
  return {
    provider,
    format: provider.permissionsConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
    toolPermissionsPath: provider.permissionsConfig.readOnlyToolPermissionsPath?.(override),
  };
}
