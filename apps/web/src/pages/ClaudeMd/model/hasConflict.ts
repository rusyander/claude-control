import type { EditorSync } from './editorSync.types';
import { sameText } from '@shared/lib/same-text';

/** Диск ушёл от сверенной версии, пока в поле были свои правки. */
export function hasConflict(state: EditorSync, disk: string): boolean {
  return !sameText(state.baseline, disk) && !sameText(state.value, state.baseline);
}
