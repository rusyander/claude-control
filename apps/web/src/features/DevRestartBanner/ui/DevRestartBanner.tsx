import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDevRestart, useRequestDevRestart } from '@entities/DevRestart';
import { formatClock } from '@shared/lib/format-clock';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Typography } from '@shared/ui/typography';
import styles from './DevRestartBanner.module.scss';
import { NAMED_FILES, WAITING_KEY } from './DevRestartBanner.constants';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * «Правки сервера ждут перезапуска» (решение 30.09). Dev-сторож не рвёт живые
 * ходы и подготовку копий ради перезапуска и ждёт их без предела; плашка
 * говорит, что правка ещё не действует и чего она ждёт, а кнопка даёт
 * перезапустить сейчас — с подтверждением, потому что ходы оборвутся.
 * Вне dev-сторожа сервер всегда отвечает «не ждут», и плашки нет.
 */
export function DevRestartBanner() {
  const { t, i18n } = useTranslation();
  const { data: status } = useDevRestart();
  const request = useRequestDevRestart();
  const [isConfirming, setIsConfirming] = useState(false);

  if (!status?.pending) return null;

  const files = status.files ?? [];
  const names = files
    .slice(0, NAMED_FILES)
    .map((file) => file.split('/').at(-1) ?? file)
    .join(', ');
  const waiting = status.waitingFor ?? 'runs';

  const confirm = (): void => {
    request.mutate(undefined, {
      onSuccess: () => setIsConfirming(false),
      onError: (error) => toast.error(t('devRestart.failed', { message: toErrorMessage(error) })),
    });
  };

  return (
    <div className={styles.root} role="status" data-dev-restart={waiting}>
      <div className={styles.text}>
        <Typography variant="body" weight="semibold">
          {t('devRestart.title')}
        </Typography>
        <Typography variant="caption" color="subtle">
          {t(WAITING_KEY[waiting])}
          {status.since
            ? ` ${t('devRestart.since', { time: formatClock(status.since, i18n.language) })}.`
            : ''}
        </Typography>
        {files.length > 0 && (
          <Typography variant="caption" color="subtle" title={files.join('\n')}>
            {t('devRestart.files', {
              count: files.length,
              names: files.length > NAMED_FILES ? `${names}…` : names,
            })}
          </Typography>
        )}
      </div>
      {status.requested ? (
        <Typography variant="caption" color="subtle" data-dev-restart-requested>
          {t('devRestart.requested')}
        </Typography>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setIsConfirming(true)}>
          {t('devRestart.restartNow')}
        </Button>
      )}
      <ConfirmDialog
        isOpen={isConfirming}
        onOpenChange={setIsConfirming}
        onConfirm={confirm}
        title={t('devRestart.confirmTitle')}
        description={t('devRestart.confirmText')}
        confirmLabel={t('devRestart.confirm')}
        isPending={request.isPending}
      />
    </div>
  );
}
