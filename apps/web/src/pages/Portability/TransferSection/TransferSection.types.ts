import type { PortabilityLevel } from '@entities/Portability';

export interface TransferSectionProps {
  source: string;
  target: string;
  targetName: string;
  /** Уровень записи: дом или проект. Едет в каждый из трёх шагов переноса. */
  level: PortabilityLevel;
}
