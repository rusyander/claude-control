import type { ChangedRow } from '../../../lib/changedRows.types';

export interface ChangedNodeProps {
  row: ChangedRow;
  isActive: boolean;
  onSelect: (path: string) => void;
  missingLabel: string;
}
