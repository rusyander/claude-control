import type { SessionWhereDetailsProps } from '../SessionActions.types';
import { useTranslation } from 'react-i18next';
import styles from './SessionWhereDetails.module.scss';
import { Typography } from '@shared/ui/typography';

/** Поля «где идёт»: процесс, время запуска, команда, каталог. */
export function SessionWhereDetails({ location }: SessionWhereDetailsProps) {
  const { t, i18n } = useTranslation();
  const { where, projectPath } = location;
  const rows: Array<[string, string, boolean?]> = [];
  if (where.kind === 'process') {
    // Место уже названо первой строкой окна — здесь только номер.
    rows.push([t('analytics.sessionFieldProcess'), `PID ${where.pid}`]);
    rows.push([
      t('analytics.sessionFieldStarted'),
      new Date(where.startedAt).toLocaleString(i18n.language),
    ]);
    rows.push([t('analytics.sessionFieldCommand'), where.command, true]);
  }
  if (projectPath) rows.push([t('analytics.sessionFieldProject'), projectPath, true]);
  if (rows.length === 0) return null;

  return (
    <dl className={styles.sessionFields}>
      {rows.map(([label, value, mono]) => (
        <div key={label} className={styles.sessionField}>
          <Typography as="dt" variant="caption" color="subtle">
            {label}
          </Typography>
          <Typography as="dd" variant={mono ? 'mono' : 'body-sm'}>
            {value}
          </Typography>
        </div>
      ))}
    </dl>
  );
}
