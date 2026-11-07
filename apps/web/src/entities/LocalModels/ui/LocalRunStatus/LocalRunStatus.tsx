import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { useNow } from '@shared/lib/use-now';
import { useLocalActivity } from '../../api/useLocalActivity';
import { useRestartLocalServer } from '../../api/useRestartLocalServer';
import { localRunView, type LocalRunStage } from '../../model/localRunView';
import type { LocalRunStatusProps } from './LocalRunStatus.types';
import styles from './LocalRunStatus.module.scss';

/**
 * Что локальная модель делает с ходом прямо сейчас (L6; этапы — по ленте звена ядра, этап 11):
 * модель, квантование и окно, этап — подъём, загрузка, очередь, разбор промпта (сколько из
 * скольких), ответ, ожидание разрешения — тишина и застой сервера и отказ с кодом и текстом,
 * с кнопкой перезапуска. Без этой строки 20 минут разбора длинного промпта неотличимы от
 * зависания, и человек слал сообщение заново, обрывая начатое.
 */
export function LocalRunStatus({ waitingPermission, since, className }: LocalRunStatusProps) {
  const { t, i18n } = useTranslation();
  const activity = useLocalActivity(true);
  const restart = useRestartLocalServer();
  // Свои часы, пока запрос в полёте: в тишине лента отдаёт тот же кадр, запрос его не меняет
  // и строку не перерисовывает — «молчит N с» иначе стоял бы до чужой перерисовки.
  const now = useNow(Boolean(activity.data?.inFlight));
  const view = localRunView(activity.data, waitingPermission, now, since);
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
  if (view.stage.key === 'failed' || view.stalled) dotTone = 'danger';
  else if (view.silent || view.failed) dotTone = 'warning';
  const offerRestart = Boolean(view.failed || view.silent || view.stalled);

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
          aria-label={t('chat.localRun.promptShare')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <span className={styles.fill} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      {view.failed && (
        <Typography as="span" variant="body-sm" color="danger" className={styles.failure}>
          {t('chat.localRun.failure', view.failed)}
        </Typography>
      )}
      {(view.silent || view.stalled || offerRestart) && (
        <div className={styles.line}>
          {view.stalled && (
            <Typography as="span" variant="body-sm" color="danger">
              {t('chat.localRun.stalled', view.stalled)}
            </Typography>
          )}
          {view.silent && (
            <Typography as="span" variant="body-sm" color="warning">
              {t('chat.localRun.silent', view.silent)}
            </Typography>
          )}
          {offerRestart && (
            <Button
              size="sm"
              variant="secondary"
              isLoading={restart.isPending}
              onClick={() =>
                restart.mutate(undefined, {
                  onError: (error) =>
                    toast.error(
                      t('chat.localRun.restartFailed', { message: toErrorMessage(error) }),
                    ),
                })
              }
            >
              {restart.isPending ? t('chat.localRun.restarting') : t('chat.localRun.restart')}
            </Button>
          )}
        </div>
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
