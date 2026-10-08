import type { ProjectFileContent } from '@agentdeck/contracts';
import { canEditText } from './canEditText';
import { canPreview } from './previewMode';

/** Есть ли что переключать: обе стороны существуют только у SVG и разметки. */
export function hasBothSides(file: ProjectFileContent | undefined): boolean {
  return canPreview(file) && canEditText(file);
}
