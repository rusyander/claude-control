import { useTranslation } from 'react-i18next';
import type { LocalJob } from '@agentdeck/contracts/local-models';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { serverFieldText } from '@shared/config/i18n';
import { jobEtaSec, jobShare, toGb } from '../model/view';
import styles from './JobProgress.module.scss';

interface JobProgressProps {
  job: LocalJob;
  onCancel?: () => void;
}

/** Байтов нет у установки пакетов: там счётчик — число полученных пакетов. */
const COUNTED_PHASES = new Set(['install']);

/**
 * Полоса долгой работы: этап словами, сколько из скольких, скорость, сколько
 * осталось. Показывается и для законченной работы — с ошибкой или «отменено»,
 * чтобы человек увидел исход, а не исчезнувшую полосу.
 */
export function JobProgress({ job, onCancel }: JobProgressProps) {
  const { t } = useTranslation();
  if (job.state === 'failed') {
    return (
      <Typography variant="body-sm" color="danger" role="alert">
        {t('localModels.job.failed', { error: serverFieldText(job, 'error') })}
      </Typography>
    );
  }
  if (job.state === 'cancelled') {
    return (
      <Typography variant="body-sm" color="muted">
        {t('localModels.job.cancelled')}
      </Typography>
    );
  }
  if (job.state === 'done') {
    return (
      <Typography variant="body-sm" color="success">
        {t('localModels.job.done')}
      </Typography>
    );
  }
  const share = jobShare(job);
  const eta = jobEtaSec(job);
  const phase = t(`localModels.job.phase.${job.phase}`, { defaultValue: job.phase });
  const percent = share === undefined ? 0 : Math.round(share * 100);
  const counted = COUNTED_PHASES.has(job.phase);
  return (
    <div className={styles.root}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(share === undefined ? {} : { 'aria-valuenow': percent })}
        aria-label={t('localModels.job.progressAria', { what: phase, percent })}
      >
        <span
          className={share === undefined ? `${styles.fill} ${styles.indeterminate}` : styles.fill}
          style={share === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className={styles.line}>
        <Typography variant="caption" color="muted">
          {[
            phase,
            counted && job.doneBytes > 0
              ? t('localModels.job.packages', { count: job.doneBytes })
              : '',
            !counted && job.totalBytes > 0
              ? t('localModels.job.bytes', {
                  done: toGb(job.doneBytes),
                  total: toGb(job.totalBytes),
                })
              : '',
            !counted && job.speed > 0
              ? t('localModels.job.speed', {
                  value: Math.round((job.speed / 1024 ** 2) * 10) / 10,
                })
              : '',
            eta === undefined ? '' : t('localModels.job.eta', { value: formatEta(t, eta) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('localModels.job.cancel')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function formatEta(t: (key: string, options: { count: number }) => string, sec: number): string {
  return sec >= 90
    ? t('localModels.job.minutes', { count: Math.round(sec / 60) })
    : t('localModels.job.seconds', { count: sec });
}
