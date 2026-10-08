import type { ChildStageGroup } from '../ChildStages.types';

export interface GroupCardProps {
  group: ChildStageGroup;
  /** Родитель плана: адрес уборки копии. Нет — кнопки уборки нет. */
  parentChatId?: string;
  /** Открыть чат группы; карточке без чата не передаётся — открывать нечего. */
  onOpen?: (chatId: string) => void;
  onAnswerHold?: (index: number, answer: string) => void;
  holdBusy?: boolean;
  onRelease?: (index: number) => void;
  releaseBusy?: boolean;
  onResumeInterrupted?: (index?: number) => void;
  resumeInterruptedBusy?: boolean;
}
