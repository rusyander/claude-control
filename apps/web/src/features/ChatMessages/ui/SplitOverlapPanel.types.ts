import type { SplitOverlapView } from '@agentdeck/contracts/chat-handoff';

export interface SplitOverlapPanelProps {
  /** Нет — сверки ещё не было: показываем один заголовок с кнопкой. */
  overlap?: SplitOverlapView;
  /** Название группы по её номеру — в пересечениях живут индексы, не имена. */
  titleOf: (index: number) => string;
  /** Пересчитать; нет обработчика — кнопки нет (сверка выключена на сервере). */
  onCheck?: () => void;
  busy?: boolean;
  /**
   * Раздел раскрыт с первого кадра. Для витрины и проверок: человеку длинный
   * список показывается свёрнутым.
   */
  defaultExpanded?: boolean;
}
