import type { TestsBoard } from '../model/useTestsBoard';

export interface ProjectTestsRunBarProps {
  board: TestsBoard;
  /** Пожелание агенту словами: «только чат», «добавь тесты на аналитику». */
  scope: string;
  onScopeChange: (value: string) => void;
  /** Окружение прогона; пусто — берётся умолчание проекта. */
  environmentId?: string;
  onEnvironmentChange?: (value: string) => void;
}
