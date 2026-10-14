import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';

export interface CatalogCardProps {
  info: LocalModelsInfo;
}

/** Что подтверждается к удалению: скачанная модель, своя запись или обе вместе. */
export interface RemoveTarget {
  tag: string;
  sizeBytes: number;
  custom: boolean;
}
