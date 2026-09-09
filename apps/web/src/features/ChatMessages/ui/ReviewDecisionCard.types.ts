import type { SplitReviewView } from '@agentdeck/contracts/chat-handoff';
import type { TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';

/** Одна ревью-группа глазами карточки: чей это MR и что с ним уже произошло. */
export interface ReviewDecisionItem {
  /** Разговор группы — им и адресуется решение. */
  chatId: string;
  /** Название группы: в хабе карточек бывает несколько, и они об разных MR. */
  title?: string;
  /** Дерево, из которого пришёл клик: сервер проверяет, что группа его. */
  parentChatId?: string;
  review: SplitReviewView;
}

export interface ReviewDecisionCardProps {
  item: ReviewDecisionItem;
  /**
   * Сколько ЕЩЁ групп дерева ждут решения. Больше нуля — появляется «то же
   * решение остальным»: разбирать десять одинаковых карточек руками человек не
   * нанимался. В самом чате группы соседей не видно, и переключателя там нет.
   */
  others?: number;
  onDecide: (chatId: string, decision: TaskSplitReviewDecision, all: boolean) => void;
  /** «Закоммитить и отправить в MR» — вторым кликом, уже после правок. */
  onPush?: (chatId: string) => void;
  /** Запрос в пути: кнопки крутятся, второй клик не уходит. */
  busy?: boolean;
}
