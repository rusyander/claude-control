import type { EditorSync } from './editorSync.types';
import { sameText } from '@shared/lib/same-text';

export function syncWithDisk(state: EditorSync | undefined, disk: string): EditorSync {
  if (!state || sameText(state.value, state.baseline) || sameText(state.value, disk)) {
    return { value: disk, baseline: disk };
  }
  return state;
}
