import type { CascadeStage } from '@agentdeck/contracts/model-cascade';
import type { ChildPermission } from '../ChildPermission.types';

export interface GroupPermissionProps {
  /** Запросы прав звеньев группы — у каждого свой ключ прогона. */
  permissions: ChildPermission[];
  /** Стадия последнего звена: человеку видно, на чём группа встала. */
  stage?: CascadeStage;
  onDecide: (chatId: string, toolUseId: string, behavior: 'allow' | 'deny') => void;
}
