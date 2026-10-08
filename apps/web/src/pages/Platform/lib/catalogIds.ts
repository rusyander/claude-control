import type { PlatformHealthRecord } from '@agentdeck/contracts';
import { catalogChatModels } from '@agentdeck/contracts/platform-models';

/** Идентификаторы моделей каталога, которыми можно вести разговор. */
export function catalogIds(health: PlatformHealthRecord | undefined): string[] {
  return catalogChatModels(health?.models ?? []).map((model) => model.id);
}
