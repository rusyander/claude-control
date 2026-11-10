import type { DiffNotesState } from '../../../model/useDiffNotes';

export interface DiffNotesTrayProps {
  /** Лоток целиком — черновик, заметки, отправка (`useDiffNotes`). */
  state: DiffNotesState;
}
