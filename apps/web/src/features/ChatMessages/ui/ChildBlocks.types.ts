import type { ChildPermission, ChildQuestion } from './ChatMessages.types';
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
  /** Запросы прав детей: на них ребёнок СТОИТ. */
  permissions?: ChildPermission[];
  onPermissionDecide?: (chatId: string, toolUseId: string, behavior: 'allow' | 'deny') => void;
  /** Вопросы детей, ждущие ответа. */
  questions?: ChildQuestion[];
  onAnswer?: (chatId: string, answer: string) => void;
}
