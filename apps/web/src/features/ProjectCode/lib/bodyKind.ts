import type { ProjectFileContent } from '@agentdeck/contracts';
import type { CodeTab } from './previewMode.types';
import { canEditText } from './canEditText';
import { canPreview } from './previewMode';

/** Что рисовать в правой половине: редактор, показ файла или объяснение. */
export type CodeBody = 'editor' | 'preview' | 'placeholder';

/**
 * Что показать, с учётом того, что у файла может не быть второй стороны:
 * у картинки нет исходника, у обычного кода — показа.
 */
export function bodyKind(file: ProjectFileContent | undefined, tab: CodeTab): CodeBody {
  if (!file) return 'placeholder';
  if (tab === 'preview' && canPreview(file)) return 'preview';
  if (canEditText(file)) return 'editor';
  return 'placeholder';
}
