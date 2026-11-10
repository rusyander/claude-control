import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffNote, NoteAnchor } from '../lib/diffNotes.types';
import { noteKey, sortNotes } from '../lib/notesMessage';
import {
  changeChat,
  dropSent,
  notesOf,
  saveNote,
  withDraft,
  type DraftsByChat,
  type NotesByChat,
} from '../lib/notesTray';
import { sendNotes } from './sendNotes';
import type { DiffNotesSend, NotesMode } from './sendNotes.types';
import type { NoteDraft } from './useDiffNotes.types';

/**
 * Лоток заметок к строкам правок. Заметки копятся по всем файлам окна и уходят
 * ОДНИМ сообщением — кнопкой «Сейчас» или «В очередь» (D21).
 *
 * Лоток свой у каждого разговора: окно кода живёт поверх чата и переживает
 * переключение разговоров, а заметки к правкам одного чата, отправленные в
 * другой, указывали бы на чужие строки. Переключение туда и обратно лоток не
 * теряет.
 */
export function useDiffNotes(chatId: string | undefined, port: DiffNotesSend | undefined) {
  const { t } = useTranslation();
  const key = chatId ?? '';
  const [byChat, setByChat] = useState<NotesByChat>({});
  // Черновик тоже свой у разговора: окно переживает смену чата, и общий черновик сохранился бы
  // в лоток другого разговора — заметка к чужой строке ушла бы не тому агенту.
  const [drafts, setDrafts] = useState<DraftsByChat<NoteDraft>>({});
  const draft = drafts[key];
  const setDraft = (next: NoteDraft | undefined): void =>
    setDrafts((all) => withDraft(all, key, next));
  const [isSending, setSending] = useState(false);
  const notes = notesOf(byChat, key);
  const sorted = useMemo(() => sortNotes(notes), [notes]);

  const update = (change: (list: readonly DiffNote[]) => readonly DiffNote[]): void =>
    setByChat((all) => changeChat(all, key, change));

  /** Строки открытого файла, у которых есть заметка, — для пометки в поле. */
  const linesOf = (path: string): ReadonlySet<number> =>
    new Set(notes.filter((note) => note.path === path).map((note) => note.line));

  /** Клик по «+» у строки: открыть черновик, у строки с заметкой — с её текстом. */
  const pick = (anchor: NoteAnchor): void => {
    const existing = notes.find((note) => noteKey(note) === noteKey(anchor));
    setDraft({ ...anchor, note: existing?.note ?? '', isEdit: Boolean(existing) });
  };

  const changeDraft = (note: string): void =>
    setDrafts((all) => {
      const current = all[key];
      return current ? withDraft(all, key, { ...current, note }) : all;
    });

  /** Сохранить черновик; пустой текст у прежней заметки — убрать её. */
  const saveDraft = (): void => {
    if (!draft) return;
    const { isEdit: _isEdit, ...anchor } = draft;
    update((list) => saveNote(list, anchor, draft.note));
    setDraft(undefined);
  };

  const remove = (note: DiffNote): void =>
    update((list) => list.filter((item) => noteKey(item) !== noteKey(note)));

  const send = async (mode: NotesMode): Promise<void> => {
    if (!port || isSending || notes.length === 0) return;
    const sent = notes;
    setSending(true);
    try {
      await sendNotes({
        port,
        mode,
        notes: sent,
        labels: {
          header: t('diffNotes.messageHeader', { count: sent.length }),
          emptyLine: t('diffNotes.emptyLine'),
        },
        // Снимаем ровно отправленные: заметка, дописанная, пока шла отправка,
        // остаётся в лотке до следующей.
        clear: () => update((list) => dropSent(list, sent)),
      });
    } finally {
      setSending(false);
    }
  };

  return {
    isEnabled: Boolean(port),
    isRunning: port?.isRunning ?? false,
    notes: sorted,
    draft,
    isSending,
    linesOf,
    pick,
    changeDraft,
    saveDraft,
    cancelDraft: () => setDraft(undefined),
    remove,
    clear: () => update(() => []),
    send,
  };
}

export type DiffNotesState = ReturnType<typeof useDiffNotes>;
