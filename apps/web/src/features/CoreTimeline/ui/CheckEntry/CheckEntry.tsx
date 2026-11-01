import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { DecisionRow } from '../DecisionRow/DecisionRow';
import { RecordPeek } from '../RecordPeek/RecordPeek';
import type { CheckEntryProps } from './CheckEntry.types';

const MODE_TONE = { run: 'accent', replay: 'info', narrow: 'warning' } as const;

/**
 * Проверка в ленте (07:20): режим (прогон, повтор записи, сужение), «почему» — дословно из вида
 * ядра, и ссылка на запись, на которой стоит вердикт. Режим берётся из вида задачи по id решения,
 * а не угадывается по тексту: повтор без прогона и прогон выглядят одинаково по заголовку.
 */
export function CheckEntry({ taskId, check, outcome, reasons }: CheckEntryProps) {
  const { t } = useTranslation();
  const mode = t(`coreTimeline.check.mode.${check.mode}`);
  return (
    <Stack gap="var(--spacing-3xs)" data-check-mode={check.mode}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Badge tone={MODE_TONE[check.mode]}>{t('coreTimeline.check.title', { mode })}</Badge>
      </Stack>
      <DecisionRow cls="check" outcome={outcome} reasons={reasons} />
      {check.why && (
        <Typography variant="caption" color="muted" data-check-why>
          {t('coreTimeline.check.why')}: <span lang="en">{check.why}</span>
        </Typography>
      )}
      {check.recordId ? (
        <RecordPeek taskId={taskId} recordId={check.recordId} />
      ) : (
        <Typography variant="caption" color="subtle" data-check-no-record>
          {t('coreTimeline.check.noRecord')}
        </Typography>
      )}
    </Stack>
  );
}
