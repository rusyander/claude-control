import type { NoteAnchor } from '../lib/diffNotes.types';

/** Черновик заметки: строка выбрана, текст ещё пишется. */
export interface NoteDraft extends NoteAnchor {
  note: string;
  /** У строки уже есть заметка — черновик её правит, а не заводит вторую. */
  isEdit: boolean;
}
