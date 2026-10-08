import type { SectionRow } from '../../lib/contourConfigView';

export interface SectionNoteProps {
  row: SectionRow;
  filesApplied: boolean;
  onOpenAccess: () => void;
}
