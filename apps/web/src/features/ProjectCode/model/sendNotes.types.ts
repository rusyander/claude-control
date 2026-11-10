import type { DiffNote, NotesMessageLabels } from '../lib/diffNotes.types';

/** «Сейчас» — в текущий ход (на ходу), «В очередь» — следующим ходом. */
export type NotesMode = 'now' | 'queue';

/**
 * Дорога отправки из чата: окно кода само сообщений не шлёт, а пользуется
 * отправкой страницы чата — с её моделью, правом на правки и оптимистичным
 * пузырём. Нет дороги (окно открыто не из чата) — лотка заметок нет.
 */
export interface DiffNotesSend {
  /** Ключ прогона чата — по нему стор прогонов знает живой ход. */
  chatId?: string;
  /** Агент сейчас работает: «Сейчас» уходит на ходу, «В очередь» ждёт конца хода. */
  isRunning: boolean;
  /** Обычная отправка свободному агенту; `false` — сообщение не приняли. */
  dispatch: (prompt: string) => Promise<boolean>;
  /** Параметры хода — те же, что у сообщения из поля ввода. */
  message: { allowEdits?: boolean; autoApprove?: boolean; model?: string; effort?: string };
}

export interface SendNotesInput {
  port: DiffNotesSend;
  mode: NotesMode;
  notes: readonly DiffNote[];
  labels: NotesMessageLabels;
  /** Снять отправленные заметки с лотка — зовётся только после «принято». */
  clear: () => void;
}
