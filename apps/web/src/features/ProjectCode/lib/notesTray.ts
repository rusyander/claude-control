import type { DiffNote, NoteAnchor } from './diffNotes.types';
import { noteKey } from './notesMessage';

/** Лотки заметок по разговорам: ключ — id чата, '' — чат ещё без id. */
export type NotesByChat = Readonly<Record<string, readonly DiffNote[]>>;

const NONE: readonly DiffNote[] = [];

/** Лоток одного разговора; другие разговоры не видны и не задеты. */
export function notesOf(all: NotesByChat, chat: string): readonly DiffNote[] {
  return all[chat] ?? NONE;
}

/** Изменить лоток одного разговора, не трогая лотки остальных. */
export function changeChat(
  all: NotesByChat,
  chat: string,
  change: (list: readonly DiffNote[]) => readonly DiffNote[],
): NotesByChat {
  return { ...all, [chat]: change(notesOf(all, chat)) };
}

/**
 * Черновики заметок по разговорам. Окно кода переживает переключение чатов, и общий черновик
 * уезжал бы в чужой лоток: строка, выбранная в правках одного разговора, ушла бы агенту другого.
 */
export type DraftsByChat<T> = Readonly<Record<string, T>>;

/** Поставить или снять (`undefined`) черновик одного разговора; чужие не тронуты. */
export function withDraft<T>(
  all: DraftsByChat<T>,
  chat: string,
  draft: T | undefined,
): DraftsByChat<T> {
  const { [chat]: _dropped, ...rest } = all;
  return draft === undefined ? rest : { ...rest, [chat]: draft };
}

/**
 * Сохранить заметку к строке: у строки одна заметка — новая заменяет прежнюю,
 * пустой текст убирает её.
 */
export function saveNote(
  list: readonly DiffNote[],
  anchor: NoteAnchor,
  text: string,
): readonly DiffNote[] {
  const rest = list.filter((note) => noteKey(note) !== noteKey(anchor));
  const note = text.trim();
  return note ? [...rest, { ...anchor, note }] : rest;
}

/**
 * Снять отправленные заметки. Только их: заметка, дописанная или исправленная,
 * пока шла отправка, — это другой объект, и она остаётся до следующей.
 */
export function dropSent(
  list: readonly DiffNote[],
  sent: readonly DiffNote[],
): readonly DiffNote[] {
  return list.filter((note) => !sent.includes(note));
}
