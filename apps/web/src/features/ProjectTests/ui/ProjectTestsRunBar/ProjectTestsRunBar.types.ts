import type { DraftBox } from '@shared/lib/draft';
import type { TestsBoard } from '../../model/useTestsBoard';

export interface ProjectTestsRunBarProps {
  board: TestsBoard;
  /**
   * Пожелание агенту словами: «только чат», «добавь тесты на аналитику». Ящик,
   * а не строка: на букву перерисовывается пульт, а не страница, которая его держит.
   */
  scope: DraftBox;
  /** Окружение прогона; пусто — берётся умолчание проекта. */
  environmentId?: string;
  onEnvironmentChange?: (value: string) => void;
}
