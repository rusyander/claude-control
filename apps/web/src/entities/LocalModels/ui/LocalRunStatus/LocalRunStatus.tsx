import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useLocalActivity } from '../../api/useLocalActivity';
import { useRestartLocalServer } from '../../api/useRestartLocalServer';
import { localRunView, type LocalRunStage } from '../../model/localRunView';
import { LocalLayerNotice } from '../LocalLayerNotice/LocalLayerNotice';
import type { LocalRunStatusProps } from './LocalRunStatus.types';
import styles from './LocalRunStatus.module.scss';

/**
 * Что локальная модель делает с ходом прямо сейчас (L6): модель, квантование и окно, этап —
 * загрузка, разбор промпта (сколько из скольких), ответ, ожидание разрешения — и тишина
 * сервера с кнопкой перезапуска. Без этой строки 20 минут разбора длинного промпта
 * неотличимы от зависания, и человек слал сообщение заново, обрывая начатое.
 */
export function LocalRunStatus({ waitingPermission, since, className }: LocalRunStatusProps) {
  const { t, i18n } = useTranslation();
  const activity = useLocalActivity(true);
  const restart = useRestartLocalServer();
  const view = localRunView(activity.data, waitingPermission, Date.now(), since);
  const number = (value: number): string => value.toLocaleString(i18n.language);
  const server = view.server
    ? t('chat.localRun.server', {
        model: view.server.model,
        quant: view.server.quant ?? '—',
        context: view.server.context ? number(view.server.context) : '—',
      })
    : t('chat.localRun.serverUnknown');
  const share = view.stage.key === 'prompt' ? view.stage.share : undefined;
  let dotTone: 'success' | 'warning' | 'danger' = 'success';
  if (view.stage.key === 'failed') dotTone = 'danger';
  else if (view.silent || view.failed) dotTone = 'warning';

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
          {stageText(view.stage, t, number)}
        </Typography>
      </div>
      {share !== undefined && (
        <div
          className={styles.track}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <span className={styles.fill} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      {view.silent && (
        <div className={styles.line}>
          <Typography as="span" variant="body-sm" color="warning">
            {t('chat.localRun.silent', view.silent)}
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
      {view.failed && (
        <Typography as="span" variant="body-sm" color="danger" className={styles.failure}>
          {t('chat.localRun.failure', view.failed)}
        </Typography>
      )}
      <LocalLayerNotice layer={activity.data?.layer} />
      {view.stalled && !view.silent && (
        <Typography as="span" variant="body-sm" color="muted">
          {t('chat.localRun.stalled', view.stalled)}
        </Typography>
      )}
    </div>
  );
}

function stageText(
  stage: LocalRunStage,
  t: ReturnType<typeof useTranslation>['t'],
  number: (value: number) => string,
): string {
  switch (stage.key) {
    case 'prompt':
      return stage.total
        ? t('chat.localRun.prompt', { filled: number(stage.filled), total: number(stage.total) })
        : t('chat.localRun.promptNoTotal', { filled: number(stage.filled) });
    case 'generating':
      return t('chat.localRun.generating', { decoded: number(stage.decoded) });
    default:
      return t(`chat.localRun.${stage.key}`);
  }
}
