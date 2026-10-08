import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { chatTreeKeys, useRecheckGroup } from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
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
 */
export function GroupRecheck({ recheck }: GroupRecheckProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useRecheckGroup();
  const state = viewOf(recheck);
  const time = recheck.checkedAt ? limitTime(recheck.checkedAt, i18n.language) : undefined;

  const run = (): void => {
    if (mutation.isPending || state === 'pending') return;
    mutation.mutate(
      { parentChatId: recheck.parentChatId, index: recheck.index },
      {
        onSuccess: (result) => {
          toast.success(
            t(
              result.outcome === 'queued'
                ? 'chat.cascade.hub.recheck.queued'
                : 'chat.cascade.hub.recheck.sent',
            ),
          );
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
    <div className={styles.holdActions} data-recheck-group={state} data-group-index={recheck.index}>
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
      <Button
        size="sm"
        variant="secondary"
        className={state === 'checked' ? styles.recheckChecked : undefined}
        isLoading={mutation.isPending}
        disabled={state === 'pending'}
        title={t(hint)}
        onClick={run}
      >
        {t(label)}
      </Button>
    </div>
  );
}
