import type { LocalChoiceBody } from '@agentdeck/contracts/local-models';
import type { CatalogRow } from '@entities/LocalModels';

export interface ModelSelectsProps {
  row: CatalogRow;
  /** Выбор сохраняется сразу, на каждое изменение. */
  onChoose: (body: Omit<LocalChoiceBody, 'tag'>) => void;
}
