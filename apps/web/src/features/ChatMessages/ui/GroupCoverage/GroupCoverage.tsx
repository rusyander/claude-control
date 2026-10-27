import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import type { GroupCoverageProps } from './GroupCoverage.types';
import styles from './GroupCoverage.module.scss';

/**
 * Фишка охвата сторожа в карточке группы: чем он её видит и каких источников нет.
 * Полный охват (живой поток, все источники) карточка не передаёт вовсе (`GroupCard`):
 * фишка нужна там, где тишина сторожа не значит «всё хорошо», на каждой карточке
 * она была бы шумом.
 */
export function GroupCoverage({ coverage }: GroupCoverageProps) {
  const { t } = useTranslation();
  const by = t(`groupWatch.coverage.by.${coverage.by}`);
  const gaps = coverage.gaps.map((gap) => t(`groupWatch.coverage.gap.${gap}`)).join(', ');
  const label =
    coverage.gaps.length > 0
      ? t('groupWatch.coverage.chipGaps', { by, gaps })
      : t('groupWatch.coverage.chip', { by });
  const hint = [
    t('groupWatch.coverage.chipHint'),
    ...coverage.gaps.map((gap) => t(`groupWatch.coverage.gapHint.${gap}`)),
  ].join(' · ');
  // Только текст или никак — правила вызовов молчат: заметнее, чем пробел одного журнала.
  const tone = coverage.by === 'text-only' || coverage.by === 'blind' ? 'warning' : 'neutral';
  return (
    <span
      className={styles.root}
      title={hint}
      data-watch-coverage={coverage.by}
      data-watch-gaps={coverage.gaps.join(' ')}
    >
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}
