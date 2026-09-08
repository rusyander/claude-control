import type { ReactNode } from 'react';
import type { TestsBoard } from '../model/useTestsBoard';

export interface TestLibraryProps {
  board: TestsBoard;
  /** Кнопки, которые добавляет владелец экрана: например, «пройти руками». */
  actions?: ReactNode;
  /**
   * Чем встречать пустой проект вместо общей заглушки: раздел тестов кладёт
   * сюда первые шаги, окно тестов из чата — ничего.
   */
  empty?: ReactNode;
}
