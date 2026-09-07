import type { TestsBoard } from '@features/ProjectTests';

export interface TestsLibraryTabProps {
  board: TestsBoard;
  /** Пожелание агенту словами — живёт на странице, потому что переживает вкладки. */
  scope: string;
  onScopeChange: (value: string) => void;
  environmentId: string;
  onEnvironmentChange: (value: string) => void;
  /** Начать ручной проход по тому, что сейчас отобрано или отмечено. */
  onStartManual: () => void;
  isStartingManual: boolean;
}
