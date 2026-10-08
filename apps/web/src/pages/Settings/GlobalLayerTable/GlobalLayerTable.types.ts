import type { GlobalLayerDirection, GlobalLayerRow } from '@agentdeck/contracts';

export interface GlobalLayerTableProps {
  rows: GlobalLayerRow[];
  /** Перенос идёт — кнопки строк ждут. */
  busy: boolean;
  onTransfer: (direction: GlobalLayerDirection, sieve: string) => void;
}
