import type { CatalogRow } from '@entities/LocalModels';

export interface ModelRowProps {
  row: CatalogRow;
  /** Эта модель сейчас работает у агентов. */
  inUse: boolean;
  serverReady: boolean;
  busy: { pull: boolean; bench: boolean; connect: boolean };
  onPull: () => void;
  onImport: () => void;
  onConnect: () => void;
  onBench: () => void;
  onRemove: () => void;
  onCancel: (id: string) => void;
}
