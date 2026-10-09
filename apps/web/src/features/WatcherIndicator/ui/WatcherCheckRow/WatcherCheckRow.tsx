import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import type { WatcherCheckRowProps } from './WatcherCheckRow.types';
import styles from './WatcherCheckRow.module.scss';

/**
 * Одна проверка человека: его текст и чем кончилось. Причина модели — второй
 * строкой: «не подтвердился» без «почему» читалось бы как отмахнулись.
 */
export function WatcherCheckRow({ check }: WatcherCheckRowProps) {
  const { t } = useTranslation();
  const label =
    check.state === 'confirmed' && !check.ref
      ? t('watcher.bug.state.confirmedNoRef')
      : t(`watcher.bug.state.${check.state}`, { ref: check.ref ?? '' });

  return (
    <li className={styles.row} data-watcher-check={check.state}>
      <Typography variant="caption" as="span" className={styles.text} title={check.text}>
        {check.text}
      </Typography>
      <Typography
        variant="caption"
        as="span"
        className={cn(styles.state, styles[check.state])}
        title={t(`watcher.bug.stateHint.${check.state}`)}
      >
        {label}
      </Typography>
      {check.reason && check.state !== 'checking' && (
        <Typography variant="caption" color="subtle" as="span">
          {check.reason}
        </Typography>
      )}
    </li>
  );
}
