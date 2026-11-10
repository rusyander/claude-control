import type { NoteAnchor } from '../../lib/diffNotes.types';

export interface NotesGutterOptions {
  /** Строки открытого файла, у которых уже есть заметка. */
  lines: ReadonlySet<number>;
  /** Подсказка у метки («Заметка к строке»). */
  label: string;
  /** Клик по метке: строка и её текст; путь файла добавляет редактор. */
  onPick: (anchor: Omit<NoteAnchor, 'path'>) => void;
}

/** Заметки в редакторе: какие строки помечены и что делать по клику. */
export interface EditorNotes {
  lines: ReadonlySet<number>;
  label: string;
  onPick: (anchor: NoteAnchor) => void;
  /**
   * Сюда редактор кладёт чтение строки курсора — для кнопки «Заметка» над
   * редактором (дорога с клавиатуры: поле меток мышиное).
   */
  cursor: { current: (() => Omit<NoteAnchor, 'path'> | undefined) | null };
}
