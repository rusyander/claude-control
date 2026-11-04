import type { ChildStageGroup } from '../ChildStages.types';

export interface GroupProgressProps {
  chatId: string;
  group: Pick<
    ChildStageGroup,
    'isRunning' | 'awaitingPermission' | 'startedAt' | 'lastAt' | 'runStartedAt'
  >;
}
