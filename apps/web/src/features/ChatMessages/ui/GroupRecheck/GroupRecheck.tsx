import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { RECHECK_NOTE_MAX } from '@agentdeck/contracts/chat-handoff';
import { chatTreeKeys, useRecheckGroup } from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { limitTime } from '../../lib/limitTime';
import type { GroupRecheckProps } from '../GroupRecheck.types';
import styles from './GroupRecheck.module.scss';
import { TEXTS } from './GroupRecheck.constants';
import { viewOf } from '../../lib/viewOf';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';
import { messageCodeOf } from '../../../../shared/api/messageCodeOf';

/**
 * «Перепроверить MR» доставленной группы (владелец 05.10.2026): конфликты с
 * целевой веткой, замечания ревьюера, конвейер и готовность задач. До первой
 * проверки кнопка обычная; идёт — «перепроверяется»; кончилась доставкой —
 * зелёная, с временем последней проверки, и остаётся зелёной, пока новая
 * работа группы её не снимет. Нажать снова можно и на зелёной.
 *
 * «Заметка» (аудит g5 27.10, H1) раскрывает поле: текст уходит в задание
 * перепроверки дословно — ревью владельца, которого нет в MR, иначе группе не
 * передать.
 */
export function GroupRecheck({ recheck }: GroupRecheckProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useRecheckGroup();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const state = viewOf(recheck);
  const time = recheck.checkedAt ? limitTime(recheck.checkedAt, i18n.language) : undefined;
  const noteText = noteOpen ? note.trim() : '';
  const noteTooLong = noteText.length > RECHECK_NOTE_MAX;

  const run = (): void => {
    if (mutation.isPending || state === 'pending' || noteTooLong) return;
    mutation.mutate(
      {
        parentChatId: recheck.parentChatId,
        index: recheck.index,
        ...(noteText ? { note: noteText } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success(
            t(
              result.outcome === 'queued'
                ? 'chat.cascade.hub.recheck.queued'
                : 'chat.cascade.hub.recheck.sent',
            ),
          );
          // Заметка ушла вместе с перепроверкой — поле больше не нужно.
          setNote('');
          setNoteOpen(false);
          void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
        },
        onError: (error) => {
          // «Влит/закрыт» — не сбой, а ответ: сервер записал состояние в группу,
          // карточка перекрасится и уедет вниз (владелец 06.10.2026).
          const code = messageCodeOf(error);
          if (code === 'split-recheck-merged') toast.success(t('chat.cascade.hub.recheck.merged'));
          else if (code === 'split-recheck-closed')
            toast.info(t('chat.cascade.hub.recheck.closed'));
          else
            toast.error(t('chat.cascade.hub.recheck.failed', { message: toErrorMessage(error) }));
          void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
        },
      },
    );
  };

  const { label, hint } = TEXTS[state];

  return (
    <div data-recheck-group={state} data-group-index={recheck.index}>
      <div className={styles.holdActions}>
        {time && (
          <Typography
            variant="caption"
            color="subtle"
            className={styles.recheckTime}
            data-checked-at={recheck.checkedAt}
          >
            {t('chat.cascade.hub.recheck.checkedAt', { time })}
          </Typography>
        )}
        {state !== 'pending' && (
          <Button
            size="sm"
            variant="ghost"
            className={styles.noteToggle}
            aria-expanded={noteOpen}
            title={t('chat.cascade.hub.recheck.noteHint')}
            data-recheck-note-toggle
            onClick={() => setNoteOpen((open) => !open)}
          >
            {t('chat.cascade.hub.recheck.note')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className={state === 'checked' ? styles.recheckChecked : undefined}
          isLoading={mutation.isPending}
          disabled={state === 'pending' || noteTooLong}
          title={t(hint)}
          data-recheck-run
          onClick={run}
        >
          {t(label)}
        </Button>
      </div>
      {noteOpen && state !== 'pending' && (
        <div className={styles.noteField} data-recheck-note>
          <TextField
            label={t('chat.cascade.hub.recheck.noteLabel')}
            value={note}
            onChange={setNote}
            placeholder={t('chat.cascade.hub.recheck.notePlaceholder')}
            hint={t('chat.cascade.hub.recheck.noteFieldHint')}
            multiline
            rows={3}
            autoFocus
            {...(noteTooLong
              ? { error: t('chat.cascade.hub.recheck.noteTooLong', { max: RECHECK_NOTE_MAX }) }
              : {})}
          />
        </div>
      )}
    </div>
  );
}
