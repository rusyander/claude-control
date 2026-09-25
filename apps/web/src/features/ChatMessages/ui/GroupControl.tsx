import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  chatTreeKeys,
  usePauseGroup,
  useResumePausedGroup,
  useStartGroupNow,
} from '@entities/ChatTree';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { GroupControlProps } from './GroupControl.types';
import styles from './GroupControl.module.scss';

/** Отказы, которые снимает согласие человека: потолок групп и лимит подписки. */
const CONSENT_CODES = new Set(['split-group-no-slot', 'split-limit-active']);

function needsConsent(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return false;
  const code = (error.response.data as { messageCode?: unknown } | undefined)?.messageCode;
  return typeof code === 'string' && CONSENT_CODES.has(code);
}

/**
 * Пауза, продолжение и «запустить сейчас» одной группы в строке хаба
 * (журнал 81, 89).
 *
 * Потолок групп и лимит подписки — не ошибка, а вопрос: сервер отвечает 409 с
 * числами, и строка спрашивает «всё равно?» прямо на месте. Решение идти сверх
 * потолка — человека, панель сама его не принимает. Запрос ведёт сама кнопка,
 * как у уборки копии: хаб стоит в обеих лентах, провод через страницы был бы
 * длиннее самой кнопки.
 */
export function GroupControl({ control }: GroupControlProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pause = usePauseGroup();
  const resume = useResumePausedGroup();
  const start = useStartGroupNow();
  const [consent, setConsent] = useState<string>();
  const busy = pause.isPending || resume.isPending || start.isPending;

  const settled = (message: string): void => {
    setConsent(undefined);
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
  };
  const failed = (error: unknown): void => {
    if (needsConsent(error)) {
      setConsent(toErrorMessage(error));
      return;
    }
    setConsent(undefined);
    toast.error(t('chat.cascade.hub.control.failed', { message: toErrorMessage(error) }));
  };
  const run = (force: boolean): void => {
    if (busy) return;
    const { parentChatId, index } = control;
    const input = { parentChatId, index, ...(force ? { force: true } : {}) };
    if (control.action === 'pause') {
      pause.mutate(input, {
        onSuccess: () => settled(t('chat.cascade.hub.control.paused')),
        onError: failed,
      });
    } else if (control.action === 'resume') {
      resume.mutate(input, {
        onSuccess: (result) =>
          settled(
            t(
              result.outcome === 'queued'
                ? 'chat.cascade.hub.control.resumeQueued'
                : 'chat.cascade.hub.control.resumed',
            ),
          ),
        onError: failed,
      });
    } else {
      start.mutate(input, {
        onSuccess: () => settled(t('chat.cascade.hub.control.started')),
        onError: failed,
      });
    }
  };

  const time = control.limitUntil
    ? new Date(control.limitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : undefined;

  return (
    <div className={styles.control} data-group-control={control.action}>
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
      {consent ? (
        <>
          <Typography variant="caption" data-group-control-consent>
            {t('chat.cascade.hub.control.consent', { reason: consent })}
          </Typography>
          <Button size="sm" variant="secondary" isLoading={busy} onClick={() => run(true)}>
            {t('chat.cascade.hub.control.force')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConsent(undefined)}>
            {t('chat.cascade.hub.control.cancel')}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant={control.action === 'pause' ? 'ghost' : 'secondary'}
          isLoading={busy}
          title={t(`chat.cascade.hub.control.${control.action}Hint`)}
          onClick={() => run(false)}
        >
          {t(`chat.cascade.hub.control.${control.action}`)}
        </Button>
      )}
    </div>
  );
}
