import type { ChildPermission, ChildQuestion } from './ChatMessages.types';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from './ChildStages.types';

/**
 * Всё, что родительский разговор показывает о своих детях. Обработчики
 * необязательные: у обычного чата детей нет вовсе, и тогда блок не рисует
 * ничего.
 */
export interface ChildBlocksProps {
  /** Сводка групп разделения: кто на каком звене и чем ведётся. */
  stages?: ChildStageGroup[];
  /** Открыть звено группы — в этом же окне. */
  onOpenChild?: (chatId: string) => void;
  /** Дерево разговоров и его пауза: кнопки «Остановить всё» / «Продолжить всё». */
  tree?: ChatTreeView;
  onPauseTree?: () => void;
  onResumeTree?: () => void;
  treeBusy?: boolean;
  /** Ответ на вопрос разбора группе без чата (Т1) — уходит родителю с номером. */
  onAnswerHold?: (index: number, answer: string) => void;
  holdBusy?: boolean;
  /** «Отпустить» группу, ждущую предшественников (Т1) — туда же и тем же номером. */
  onRelease?: (index: number) => void;
  releaseBusy?: boolean;
  /** Пересчитать пересечения веток (Т6) — кнопка в сводке групп. */
  onCheckOverlap?: () => void;
  overlapBusy?: boolean;
  /** Запросы прав детей: на них ребёнок СТОИТ. */
  permissions?: ChildPermission[];
  onPermissionDecide?: (chatId: string, toolUseId: string, behavior: 'allow' | 'deny') => void;
  /** Вопросы детей, ждущие ответа. */
  questions?: ChildQuestion[];
  onAnswer?: (chatId: string, answer: string) => void;
}
