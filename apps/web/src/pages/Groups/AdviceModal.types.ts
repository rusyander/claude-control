import type { GroupListItem } from '@entities/Group';

/**
 * `copy` — проектная группа копируется в общие, потом советы;
 * `merge` — у глобальной копии оригинал изменился, агент предлагает слияние.
 */
export type AdviceMode = 'copy' | 'merge';

export interface AdviceModalProps {
  mode: AdviceMode;
  group: GroupListItem;
  onClose: () => void;
}
