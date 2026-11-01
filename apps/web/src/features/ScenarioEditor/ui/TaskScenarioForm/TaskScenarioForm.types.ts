import type { Scenario, ScenarioRef } from '@agentdeck/contracts/core/scenario';

export interface TaskScenarioFormProps {
  taskId: string;
  /** Действующая версия задачи — от неё правка (ожидающая правка главнее записанной). */
  current: ScenarioRef;
  /** Действующая версия — ожидающая правка, ещё не вступившая в силу. */
  isPending: boolean;
  library: Scenario[];
}

export interface TaskDraftProps {
  taskId: string;
  current: ScenarioRef;
  base: Scenario;
  library: Scenario[];
}
