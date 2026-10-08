import type { ProjectTestGroup } from '@agentdeck/contracts';

export interface TestsRunsTabProps {
  projectPath: string | undefined;
  /** Группы нужны, чтобы подписать результат названием кейса, а не его id. */
  groups: ProjectTestGroup[];
  /** Идёт ли прогон прямо сейчас — тогда история перечитывается сама. */
  isRunning: boolean;
  /** Прогон из адреса (`?run=`): раскрывается сразу — на него ведёт история кейса. */
  openRunId?: string;
}
