import type { DeliveryStop } from '../../lib/deliveryStop.types';

export interface DeliveryStopProps {
  stop: DeliveryStop;
  /** Ссылка на MR группы — для строки «нужен мерж MR !N». */
  mr?: string;
}
