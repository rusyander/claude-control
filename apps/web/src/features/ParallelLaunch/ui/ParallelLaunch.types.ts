import type { CascadeCeiling, CascadeChoice } from '@agentdeck/contracts/model-cascade';
import type { ProjectInfo } from '@entities/Project';

/** Чем поедет веер: пара из лестницы плюс отметка «ступень ниже потолка». */
export interface ParallelChoice extends CascadeChoice {
  lowered: boolean;
}

export interface ParallelLaunchProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectInfo[];
  /**
   * Потолок разговора, из которого запускают: модель и глубина его шапки. По
   * нему собирается список ступеней, и он же — значение по умолчанию. Пусто или
   * нераспознанное имя (чужой вендор) — выбора нет, и веер уходит ровно так, как
   * уходил до подбора.
   */
  ceiling?: CascadeCeiling;
  /** Запустить один и тот же запрос в выбранных проектах. */
  onLaunch: (
    selected: ProjectInfo[],
    prompt: string,
    allowEdits: boolean,
    choice?: ParallelChoice,
  ) => void;
}
