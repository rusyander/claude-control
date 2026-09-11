import type { EnvTransferPlatformsPlan } from './EnvTransfer.types';

export interface EnvTransferPlatformsProps {
  plan: EnvTransferPlatformsPlan;
  /** Отмеченные контуры — по идентификаторам, а не по путям: файлов у них нет. */
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Переносить ли заодно настройку локального шлюза. */
  gateway: boolean;
  onGateway: (value: boolean) => void;
}
