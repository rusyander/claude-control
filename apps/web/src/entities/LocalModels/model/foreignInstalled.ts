import type { LocalModelsInfo, InstalledModel } from '@agentdeck/contracts/local-models';

/** Установленные, которых нет в каталоге: поставлены руками или забраны из системы. */
export function foreignInstalled(info: LocalModelsInfo): InstalledModel[] {
  return info.installed.filter((item) => !item.known);
}
