import type { IconName } from '@shared/ui/icon';
import type { ComponentType } from 'react';

export interface HelpTopic {
  /** Идентификатор в адресе: /help?topic=rules. */
  id: string;
  icon: IconName;
  /** Раздел панели, к которому относится документ. */
  pagePath: string;
  /** Документ раздела. Тексты берутся из словаря help.topics.<id>. */
  Content: ComponentType;
}
