import type { TaskSplitProposal } from '@claude-control/contracts/task-split';

export interface TaskSplitCardProps {
  proposal: TaskSplitProposal;
  /**
   * Разделить на отдельные чаты. Пусто — карточка только показывает предложение
   * без кнопок: предложение из середины истории давно закрыто, и заводить по
   * нему ветки спустя десять сообщений никто не просил.
   */
  onSplit?: (options: { startRuns: boolean }) => void;
  /** Отказаться от разделения и продолжить в этом же разговоре. */
  onKeepHere?: () => void;
  /** Запрос уже пошёл: копии заводятся не мгновенно, кнопки обязаны это показать. */
  isPending?: boolean;
  /** Агент занят — отвечать ему сейчас нечем. */
  disabled?: boolean;
}
