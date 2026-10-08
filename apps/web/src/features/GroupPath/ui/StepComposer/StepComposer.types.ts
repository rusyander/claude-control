import type { Group, PathEntry } from '@agentdeck/contracts';
import type { ComposerTarget } from '../../model/useStepComposer';

export type { ComposerTarget };

export interface StepComposerProps {
  group: Group;
  /** Проект группы — его ресурсы тоже есть в каталоге «Выбрать готовый». */
  projectPath?: string;
  entries: PathEntry[];
  target: ComposerTarget;
  onClose: () => void;
}
