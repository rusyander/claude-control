import type { PortabilityLevel } from '@entities/Portability';
import type { SubscriptionDrift } from '@agentdeck/contracts/portable-subscribe';

export interface DriftCardProps {
  target: string;
  level: PortabilityLevel;
  drift: SubscriptionDrift;
  /**
   * Исход сделан — план пересборки наверху устарел.
   *
   * Карточка не пересчитывает его сама: «пересобрать» без показанного плана не
   * существует, и подсунуть человеку свежий план вместо разобранного им
   * значило бы показать решение, которого он не принимал. Наверху план
   * снимается, и кнопка возвращается к «показать».
   */
  onResolved: () => void;
}
