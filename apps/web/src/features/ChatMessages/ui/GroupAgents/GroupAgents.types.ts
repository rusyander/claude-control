import type { ChildStageGroup } from '../ChildStages.types';

export interface GroupAgentsProps {
  /** Чат группы — чьи это субагенты. */
  chatId: string;
  group: Pick<ChildStageGroup, 'isRunning'>;
  /** Открыть чат группы (переход из хаба родителя). */
  onOpen: (chatId: string) => void;
}
