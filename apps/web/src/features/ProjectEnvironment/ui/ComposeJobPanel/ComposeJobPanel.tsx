import { useTranslation } from 'react-i18next';
import { StatusDot } from '@shared/ui/status-dot';
import type { ComposeJobPanelProps } from './ComposeJobPanel.types';
import styles from './ComposeJobPanel.module.scss';

/**
 * Идущее или последнее действие над стеком. Строка состояния объявляется
 * скринридеру сама (`role="status"`); вывод docker раскрыт, пока действие идёт
 * или если оно упало, — причина отказа в нём, искать её по клику не нужно.
 */
export function ComposeJobPanel({ job }: ComposeJobPanelProps) {
  const { t } = useTranslation();
  const action = job.service
    ? t(`environment.job.serviceActions.${job.action}`, { name: job.service })
    : t(`environment.job.actions.${job.action}`);
  const tone = { running: 'warning', done: 'success', failed: 'danger' } as const;

  return (
    <section className={styles.panel} aria-label={t('environment.job.output')}>
      <p className={styles.status} role="status">
        <StatusDot tone={tone[job.status]} pulse={job.status === 'running'} />
        <span>{t(`environment.job.${job.status}`, { action })}</span>
      </p>
      {job.status === 'failed' && <p className={styles.hint}>{t('environment.job.failedHint')}</p>}
      {/* key по id: новое действие раскрывает вывод заново, даже если прошлый свернули. */}
      <details key={job.id} className={styles.output} open={job.status !== 'done'}>
        <summary>{t('environment.job.output')}</summary>
        <pre>{job.output || t('environment.job.empty')}</pre>
      </details>
    </section>
  );
}
