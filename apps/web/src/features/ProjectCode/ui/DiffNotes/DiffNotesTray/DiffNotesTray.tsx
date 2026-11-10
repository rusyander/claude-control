import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { noteKey } from '../../../lib/notesMessage';
import type { DiffNotesTrayProps } from './DiffNotesTray.types';
import styles from './DiffNotesTray.module.scss';

/**
 * Лоток заметок под редактором: черновик заметки к выбранной строке, список
 * накопленных заметок по всем файлам и одна отправка — «Сейчас» или «В очередь».
 * Пустой лоток не занимает места: ни черновика, ни заметок — нечего и рисовать.
 */
export function DiffNotesTray({ state }: DiffNotesTrayProps) {
  const { t } = useTranslation();
  const { draft, notes, isSending } = state;
  if (!draft && notes.length === 0) return null;

  // Ctrl+Enter — добавить: обычный Enter нужен для переноса строки в заметке.
  const onDraftKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      state.saveDraft();
    }
  };

  return (
    <section
      className={styles.tray}
      data-testid="diff-notes-tray"
      aria-label={t('diffNotes.title')}
    >
      {draft && (
        <div className={styles.draft}>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" minWidth={0}>
            <Typography variant="mono" color="accent" as="span" className={styles.fixed}>
              {noteKey(draft)}
            </Typography>
            <Typography variant="mono" color="muted" as="span" truncate>
              {draft.text.trim() ? draft.text : t('diffNotes.emptyLine')}
            </Typography>
          </Stack>
          <textarea
            className={styles.input}
            data-testid="diff-note-draft"
            aria-label={t('diffNotes.draftLabel', { place: noteKey(draft) })}
            placeholder={t('diffNotes.draftPlaceholder')}
            value={draft.note}
            rows={2}
            autoFocus
            onChange={(event) => state.changeDraft(event.target.value)}
            onKeyDown={onDraftKey}
          />
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)">
            <Typography variant="caption" color="subtle" as="span">
              {t('diffNotes.draftHint')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)">
              <Button size="sm" variant="ghost" onClick={state.cancelDraft}>
                {t('diffNotes.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.isEdit && !draft.note.trim()}
                onClick={state.saveDraft}
              >
                {draft.isEdit ? t('diffNotes.update') : t('diffNotes.add')}
              </Button>
            </Stack>
          </Stack>
        </div>
      )}

      {notes.length > 0 && (
        <>
          <ul className={styles.list}>
            {notes.map((note) => (
              <li key={noteKey(note)} className={styles.note} data-testid="diff-note">
                <button
                  type="button"
                  className={styles.place}
                  title={note.text}
                  onClick={() => state.pick(note)}
                >
                  {noteKey(note)}
                </button>
                <Typography variant="body-sm" as="span" className={styles.noteText}>
                  {note.note}
                </Typography>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="close" size={14} />}
                  aria-label={t('diffNotes.remove', { place: noteKey(note) })}
                  onClick={() => state.remove(note)}
                />
              </li>
            ))}
          </ul>

          <Stack
            direction="row"
            align="center"
            justify="between"
            gap="var(--spacing-sm)"
            className={styles.bar}
          >
            <Stack direction="row" align="baseline" gap="var(--spacing-xs)" minWidth={0}>
              <Typography variant="caption" as="span" className={styles.fixed}>
                {t('diffNotes.count', { count: notes.length })}
              </Typography>
              <Typography variant="caption" color="subtle" as="span" truncate>
                {state.isRunning ? t('diffNotes.hintLive') : t('diffNotes.hintIdle')}
              </Typography>
            </Stack>
            <Stack direction="row" gap="var(--spacing-2xs)" flexShrink={0}>
              <Button size="sm" variant="ghost" disabled={isSending} onClick={state.clear}>
                {t('diffNotes.clear')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Icon name="history" size={16} />}
                disabled={isSending}
                onClick={() => void state.send('queue')}
              >
                {t('diffNotes.queue')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Icon name="send" size={16} />}
                isLoading={isSending}
                onClick={() => void state.send('now')}
              >
                {t('diffNotes.now')}
              </Button>
            </Stack>
          </Stack>
        </>
      )}
    </section>
  );
}
