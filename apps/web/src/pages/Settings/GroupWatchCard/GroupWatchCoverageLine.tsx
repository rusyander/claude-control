import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { GroupWatchCoverageLineProps } from './GroupWatchCoverageLine.types';

/**
 * Строка «Охват сейчас» карточки сторожа: сколько живых групп каким источником
 * видно и каких источников нет — с тем, какие правила из-за этого молчат.
 */
export function GroupWatchCoverageLine({ summary, enabled }: GroupWatchCoverageLineProps) {
  const { t } = useTranslation();
  if (!summary) return null;
  const { groups, gaps } = summary;
  const live = groups.stream + groups.transcript + groups['text-only'];
  let counts = t('groupWatch.coverage.settingsNoGroups');
  if (!enabled && groups.blind > 0) {
    counts = t('groupWatch.coverage.settingsBlind', { count: groups.blind });
  } else if (enabled && live > 0) {
    counts = t('groupWatch.coverage.settingsGroups', {
      stream: groups.stream,
      transcript: groups.transcript,
      textOnly: groups['text-only'],
    });
  }
  let missing = enabled ? t('groupWatch.coverage.settingsFull') : '';
  if (gaps.length > 0) {
    missing = t('groupWatch.coverage.settingsGaps', {
      gaps: gaps.map((gap) => t(`groupWatch.coverage.gap.${gap}`)).join(', '),
      hints: gaps.map((gap) => t(`groupWatch.coverage.gapHint.${gap}`)).join('; '),
    });
  }
  return (
    <Typography
      variant="body-sm"
      color="subtle"
      data-group-watch-coverage
      data-watch-gaps={gaps.join(' ')}
    >
      {t('groupWatch.coverage.settingsTitle')}: {counts}
      {missing ? ` ${missing}` : ''}
    </Typography>
  );
}
