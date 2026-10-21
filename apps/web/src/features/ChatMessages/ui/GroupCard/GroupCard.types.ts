import type { ChildStageGroup } from '../ChildStages.types';
import type { ChildQuestion } from '../ChildQuestion.types';

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
}
