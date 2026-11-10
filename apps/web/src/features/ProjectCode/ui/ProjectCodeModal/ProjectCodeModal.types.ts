import type { DiffNotesSend } from '../../model/sendNotes.types';

export interface ProjectCodeModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Каталог проекта: он же корень дерева и граница записи. */
  projectPath: string;
  /**
   * Разговор, чьи правки показываются диффом. Без него файлы открываются как
   * обычно, просто без сравнения — новый чат ещё ничего не менял.
   */
  chatId?: string;
  /**
   * Отправка из чата для заметок к строкам правок: с ней у строк есть «+», под
   * редактором — лоток «Сейчас» / «В очередь». Без неё окно кода как было.
   */
  notesSend?: DiffNotesSend;
}
