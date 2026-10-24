import type { ChildStageGroup } from '../ChildStages.types';
import type { ChildQuestion } from '../ChildQuestion.types';
import type { ChildPermission } from '../ChildPermission.types';

export interface GroupCardProps {
  group: ChildStageGroup;
  /** Родитель плана: адрес уборки копии. Нет — кнопки уборки нет. */
  parentChatId?: string;
  /** Провайдер чужого CLI — для ключа «Что получил агент» (U8); у Claude нет. */
  providerId?: string;
  /** Открыть чат группы; карточке без чата не передаётся — открывать нечего. */
  onOpen?: (chatId: string) => void;
  onAnswerHold?: (index: number, answer: string) => void;
  holdBusy?: boolean;
  onRelease?: (index: number) => void;
  releaseBusy?: boolean;
  onResumeInterrupted?: (index?: number) => void;
  resumeInterruptedBusy?: boolean;
  /** Вопросы последнего звена группы (карточка 27) — островком в карточке. */
  questions?: ChildQuestion[];
  /** Ответ на них уходит в чат группы. Без обработчика островка нет. */
  onAnswer?: (chatId: string, answer: string) => void;
  /** Запросы прав звеньев группы (владелец 23.10) — островком в карточке. */
  permissions?: ChildPermission[];
  /** Решение уходит в прогон звена, под ключом которого оно спросило. Без обработчика островка нет. */
  onPermissionDecide?: (chatId: string, toolUseId: string, behavior: 'allow' | 'deny') => void;
  /** Свёрнутые разделы карточки («не хватает для MR») открыты сразу — для тестов и снимков. */
  sectionsOpen?: boolean;
}
