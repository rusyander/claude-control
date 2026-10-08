import type { PickedResource } from '../../model/useQuickStep';

export interface CatalogPickerProps {
  /** Каталог проекта группы — вдобавок к общему; у глобальной группы пусто. */
  projectPath?: string;
  isSaving: boolean;
  hasFailed: boolean;
  onPick: (item: PickedResource) => void;
  /**
   * Группа выключена: выбранный скилл, правило или хук станет её участником, и
   * сервер будет держать его выключенным везде, пока группу не включат.
   */
  isGroupOff?: boolean;
}
