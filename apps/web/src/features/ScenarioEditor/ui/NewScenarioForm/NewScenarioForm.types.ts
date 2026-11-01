import type { Scenario } from '@agentdeck/contracts/core/scenario';

export interface NewScenarioFormProps {
  /** Версии библиотеки человека: по ним — следующая версия id и свой id вместо пресетного. */
  library: Scenario[];
  /** Основа черновика; нет — сценарий с нуля из одного шага. */
  base?: Scenario;
}
