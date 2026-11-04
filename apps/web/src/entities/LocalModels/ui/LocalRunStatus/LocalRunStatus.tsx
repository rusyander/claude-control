import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useLocalActivity } from '../../api/useLocalActivity';
import { useRestartLocalServer } from '../../api/useRestartLocalServer';
import { localRunView } from '../../model/localRunView';
import type { LocalRunStatusProps } from './LocalRunStatus.types';
import styles from './LocalRunStatus.module.scss';

/**
 * Что с локальной моделью в этом ходе (L6): модель, квантование и окно, ожидание разрешения и
 * отказ сервера — красным, с его кодом и текстом и кнопкой перезапуска. Этапов хода (загрузка,
 * разбор промпта, ответ) строка не показывает: запросы ведёт ядро, ленты активности звена у него
 * пока нет.
 */
export function LocalRunStatus({ waitingPermission, since, className }: LocalRunStatusProps) {
  const { t, i18n } = useTranslation();
  const activity = useLocalActivity(true);
  const restart = useRestartLocalServer();
  const view = localRunView(activity.data, waitingPermission, since);
  const server = view.server
    ? t('chat.localRun.server', {
        model: view.server.model,
        quant: view.server.quant ?? '—',
        context: view.server.context ? view.server.context.toLocaleString(i18n.language) : '—',
      })
    : t('chat.localRun.serverUnknown');
  let dotTone: 'success' | 'warning' | 'danger' = 'success';
  if (view.stage.key === 'failed') dotTone = 'danger';
  else if (view.failed) dotTone = 'warning';

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      role="status"
      aria-label={t('chat.localRun.aria')}
      data-stage={view.stage.key}
    >
      <div className={styles.line}>
        <StatusDot tone={dotTone} pulse={dotTone === 'success'} />
        <Typography as="span" variant="body-sm" color="muted">
          {server}
        </Typography>
        <Typography as="span" variant="body-sm">
          {t(`chat.localRun.${view.stage.key}`)}
        </Typography>
      </div>
      {view.failed && (
        <div className={styles.line}>
          <Typography as="span" variant="body-sm" color="danger" className={styles.failure}>
            {t('chat.localRun.failure', view.failed)}
          </Typography>
          <Button
            size="sm"
            variant="secondary"
            isLoading={restart.isPending}
            onClick={() =>
              restart.mutate(undefined, {
                onError: (error) =>
                  toast.error(t('chat.localRun.restartFailed', { message: toErrorMessage(error) })),
              })
            }
          >
            {restart.isPending ? t('chat.localRun.restarting') : t('chat.localRun.restart')}
          </Button>
        </div>
      )}
    </div>
  );
}
