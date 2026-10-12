import type { ProjectRunnerTarget } from '@entities/ProjectRunner';

/** Найденные способы запуска цели — выбор одним щелчком. */
export interface RunnerCandidatesProps {
  target: ProjectRunnerTarget;
  /** Сохранение идёт — выбор заблокирован, чтобы два щелчка не спорили. */
  isBusy: boolean;
  /** Выбрать команду; пустая строка — вернуть автовыбор. `false` — не сохранилось. */
  onChoose: (command: string) => Promise<boolean>;
}
