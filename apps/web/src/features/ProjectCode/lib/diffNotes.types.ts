/** Строка открытого файла, к которой человек пишет заметку. */
export interface NoteAnchor {
  /** Путь от корня проекта — тот же, что в списке «Изменённые». */
  path: string;
  /** Номер строки с единицы, как в поле номеров редактора. */
  line: number;
  /** Текст строки в момент заметки: агент увидит, о чём речь, даже если строка уже уехала. */
  text: string;
}

/** Заметка к строке правки — копится в лотке до одной отправки агенту. */
export interface DiffNote extends NoteAnchor {
  note: string;
}

/** Подписи сообщения: заголовок (с числом заметок) и замена пустой строки. */
export interface NotesMessageLabels {
  header: string;
  emptyLine: string;
}
