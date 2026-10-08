import type { DiscoverySourceRowProps } from '../DiscoveryProgress.types';
import { useTranslation } from 'react-i18next';
import styles from './SourceRow.module.scss';
import { StatusDot } from '@shared/ui/status-dot';
import { STATE_TONE } from './SourceRow.constants';
import { Typography } from '@shared/ui/typography';
import { sourceLabel } from '../../model/sourceLabel';

export function SourceRow({ source }: DiscoverySourceRowProps) {
  const { t } = useTranslation();
  const label = sourceLabel(source.source);
  const name =
    label.kind === 'provider' ? t('groupSources.providerSource', { name: label.name }) : label.name;

  return (
    <li className={styles.row}>
      <StatusDot tone={STATE_TONE[source.state]} pulse={source.state === 'running'} />
      <Typography variant="mono" as="span" className={styles.name} title={name}>
        {name}
      </Typography>
      <Typography
        variant="caption"
        color={source.state === 'failed' ? 'danger' : 'subtle'}
        as="span"
        title={source.error}
      >
        {t(`groupSources.state_${source.state}`, { count: source.found })}
        {/* Сбой — словами на языке интерфейса; подробность как есть — в подсказке. */}
        {source.error
          ? ` — ${t(`groupSources.discoveryFail_${source.errorCode ?? 'failed'}`)}`
          : ''}
      </Typography>
    </li>
  );
}
