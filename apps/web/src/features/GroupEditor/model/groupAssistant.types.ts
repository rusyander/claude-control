import type { PickerItem } from './memberCatalog.types';
import type { GroupMember } from '@agentdeck/contracts';

export interface GroupAssistantInput {
  /** Всё, что можно отметить (`memberCatalog`). */
  catalog: readonly PickerItem[];
  /** Нынешний состав: участник вне каталога (локальный хук, проектный) тоже допустим. */
  members: readonly GroupMember[];
  projects: ReadonlyArray<{ path: string; name: string }>;
  /** Нынешняя привязка: путь, убранный из реестра, остаётся допустимым. */
  projectPaths: readonly string[];
}
