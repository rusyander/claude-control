import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  chatTreeKeys,
  useContinueGroup,
  useDropGroup,
  usePauseGroup,
  useRestartGroup,
  useResumePausedGroup,
  useStartGroupNow,
} from '@entities/ChatTree';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { limitTime } from '../../lib/limitTime';
import type { GroupControlAction, GroupControlProps } from '../GroupControl.types';
import styles from './GroupControl.module.scss';
import { needsConsent } from '../../lib/needsConsent';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Пауза, продолжение и «запустить сейчас» одной группы в строке хаба
 * (журнал 81, 89); у оборванной до своего чата — «завести заново» и «убрать»
 * (живой прогон 29.09).
 *
 * Потолок групп и лимит подписки — не ошибка, а вопрос: сервер отвечает 409 с
 * числами, и строка спрашивает «всё равно?» прямо на месте — про то действие,
 * которое спросило. Решение идти сверх потолка — человека, панель сама его не
 * принимает. Запрос ведёт сама кнопка, как у уборки копии: хаб стоит в обеих
 * лентах, провод через страницы был бы длиннее самой кнопки.
 */
export function GroupControl({ control }: GroupControlProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const pause = usePauseGroup();
  const resume = useResumePausedGroup();
  const start = useStartGroupNow();
  const restart = useRestartGroup();
  const drop = useDropGroup();
  const proceed = useContinueGroup();
  const [consent, setConsent] = useState<{ action: GroupControlAction; reason: string }>();
  // «Убрать» закрывает группу без возврата — подтверждение в той же строке,
  // как у «Отменить план»: случайный клик стоил бы работы группы.
  const [askingDrop, setAskingDrop] = useState(false);
  const busy =
    pause.isPending ||
    resume.isPending ||
    start.isPending ||
    restart.isPending ||
    drop.isPending ||
    proceed.isPending;

  const settled = (message: string): void => {
    setConsent(undefined);
    setAskingDrop(false);
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
  };
  const failedFor =
    (action: GroupControlAction) =>
    (error: unknown): void => {
      if (needsConsent(error)) {
        setConsent({ action, reason: toErrorMessage(error) });
        return;
      }
      setConsent(undefined);
      setAskingDrop(false);
      toast.error(t('chat.cascade.hub.control.failed', { message: toErrorMessage(error) }));
    };
  const run = (action: GroupControlAction, force: boolean): void => {
    if (busy) return;
    const { parentChatId, index } = control;
    const input = { parentChatId, index, ...(force ? { force: true } : {}) };
    const onError = failedFor(action);
    switch (action) {
      case 'pause':
        pause.mutate(input, {
          onSuccess: (result) => {
            settled(t('chat.cascade.hub.control.paused'));
            // Процесс жив, номер нечем проверить (F-145): группа на паузе, ход доходит.
            if (result.unconfirmed > 0) {
              toast.warning(t('chat.cascade.tree.notStoppedToast', { count: result.unconfirmed }));
            }
          },
          onError,
        });
        return;
      case 'resume':
        resume.mutate(input, {
          onSuccess: (result) => {
            // Что вышло, говорит ответ сервера, а не догадка строки: «queued» у
            // паузы из очереди — назад в очередь, у остальных — после хода.
            if (result.outcome !== 'queued') {
              settled(t('chat.cascade.hub.control.resumed'));
              return;
            }
            settled(
              t(
                control.fromQueue
                  ? 'chat.cascade.hub.control.requeued'
                  : 'chat.cascade.hub.control.resumeQueued',
              ),
            );
          },
          onError,
        });
        return;
      case 'restart':
        restart.mutate(input, {
          onSuccess: () => settled(t('chat.cascade.hub.control.restarted')),
          onError,
        });
        return;
      case 'continue':
        proceed.mutate(input, {
          onSuccess: (result) =>
            settled(
              t(
                result.outcome === 'queued'
                  ? 'chat.cascade.hub.control.resumeQueued'
                  : 'chat.cascade.hub.control.continued',
              ),
            ),
          onError,
        });
        return;
      case 'drop':
        drop.mutate(input, {
          onSuccess: () => settled(t('chat.cascade.hub.control.dropped')),
          onError,
        });
        return;
      default:
        start.mutate(input, {
          onSuccess: () => settled(t('chat.cascade.hub.control.started')),
          onError,
        });
    }
  };

  const time = control.limitUntil ? limitTime(control.limitUntil, i18n.language) : undefined;
  const [primary] = control.actions;

  return (
    <div
      className={styles.control}
      data-group-control-row={primary}
      data-group-index={control.index}
    >
      {time && (
        <Typography
          variant="caption"
          color="subtle"
          className={styles.caption}
          data-limit-until={control.limitUntil}
        >
          {t('chat.cascade.hub.control.limitUntil', { time })}
        </Typography>
      )}
      {consent && (
        <>
          <Typography variant="caption" data-group-control-consent>
            {t('chat.cascade.hub.control.consent', { reason: consent.reason })}
          </Typography>
          <Button
            size="sm"
            variant="secondary"
            isLoading={busy}
            onClick={() => run(consent.action, true)}
          >
            {t('chat.cascade.hub.control.force')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConsent(undefined)}>
            {t('chat.cascade.hub.control.cancel')}
          </Button>
        </>
      )}
      {!consent && askingDrop && (
        <>
          <Typography variant="caption" data-group-control-drop-confirm>
            {t('chat.cascade.hub.control.dropConfirm')}
          </Typography>
          <Button size="sm" variant="danger" isLoading={busy} onClick={() => run('drop', false)}>
            {t('chat.cascade.hub.control.dropYes')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAskingDrop(false)}>
            {t('chat.cascade.hub.control.cancel')}
          </Button>
        </>
      )}
      {!consent &&
        !askingDrop &&
        control.actions.map((action) => (
          <Button
            key={action}
            size="sm"
            // Главное действие строки — заметное; пауза и «убрать» — тихие.
            variant={action === primary && action !== 'pause' ? 'secondary' : 'ghost'}
            isLoading={busy}
            data-group-control={action}
            title={t(
              control.fromQueue && action === 'resume'
                ? 'chat.cascade.hub.control.requeueHint'
                : `chat.cascade.hub.control.${action}Hint`,
            )}
            onClick={() => (action === 'drop' ? setAskingDrop(true) : run(action, false))}
          >
            {t(`chat.cascade.hub.control.${action}`)}
          </Button>
        ))}
    </div>
  );
}
