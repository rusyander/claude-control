import type { ReactNode } from 'react';
import type { ProjectTestGroup, ProjectTestSharedStep } from '@agentdeck/contracts';

export interface TestRunnerModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  /** Группы нужны за телами кейсов: поинт знает только идентификаторы. */
  groups: ProjectTestGroup[];
  sharedSteps: ProjectTestSharedStep[];
  /**
   * Что делать, когда прохода нет: кнопки начать его отсюда же. Пульт не знает,
   * что выбрано в библиотеке, — действия собирает страница.
   */
  emptyActions?: ReactNode;
}
