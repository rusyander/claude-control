import type { DiffNote, NotesMessageLabels } from './diffNotes.types';

/**
 * Порядок блоков — по файлу, потом по строке, а не по времени заметки: агент
 * читает сообщение сверху вниз, как дифф, и правит файл за файлом. Порядок
 * добавления — случайность того, куда человек смотрел, а не смысл.
 */
export function sortNotes(notes: readonly DiffNote[]): DiffNote[] {
  return [...notes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/** Ключ заметки: на строку — одна заметка, повторная правит прежнюю. */
export const noteKey = (note: { path: string; line: number }): string =>
  `${note.path}:${note.line}`;

/**
 * Все заметки — ОДНИМ сообщением (P172): заголовок, затем на заметку блок
 * `путь:строка`, текст строки цитатой и сама заметка. Одно сообщение, а не по
 * штуке на заметку: каждое отдельное сообщение — отдельный ход агента, и три
 * заметки к одной правке превращались бы в три круга работы над ней.
 */
export function notesMessage(notes: readonly DiffNote[], labels: NotesMessageLabels): string {
  const blocks = sortNotes(notes).map((note) => {
    const line = note.text.trim() ? note.text.trimEnd() : labels.emptyLine;
    return `${noteKey(note)}\n> ${line}\n${note.note.trim()}`;
  });
  return [labels.header, ...blocks].join('\n\n');
}
