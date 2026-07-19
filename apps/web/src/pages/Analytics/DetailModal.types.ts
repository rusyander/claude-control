import type { Analytics } from '@claude-control/contracts';

export type DetailKind = 'model' | 'project';

export interface DetailModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Что раскрываем: строку по модели или по проекту. */
  kind: DetailKind;
  /** Идентификатор выбранной строки: имя модели или путь проекта. */
  id: string;
  analytics: Analytics;
}
