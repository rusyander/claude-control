import type { ChildStageGroup } from '../ChildStages.types';
import type { ChildQuestion } from '../ChildQuestion.types';
import type { ChildPermission } from '../ChildPermission.types';

export interface GroupCardProps {
  group: ChildStageGroup;
  /** Провайдер чужого CLI — для ключа «Что получил агент» (U8); у Claude нет. */
  providerId?: string;
  /** Открыть чат группы; карточке без чата не передаётся — открывать нечего. */
  onOpen?: (chatId: string) => void;
  /** Вопросы последнего звена группы (карточка 27) — островком в карточке. */
  questions?: ChildQuestion[];
  /** Ответ на них уходит в чат группы. Без обработчика островка нет. */
  onAnswer?: (chatId: string, answer: string) => void;
  /** Запросы прав звеньев группы (владелец 23.10) — островком в карточке. */
  permissions?: ChildPermission[];
  /** Решение уходит в прогон звена, под ключом которого оно спросило. Без обработчика островка нет. */
  onPermissionDecide?: (chatId: string, toolUseId: string, behavior: 'allow' | 'deny') => void;
}
