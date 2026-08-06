import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { useClearDlpJournal, useDlpJournal } from '@entities/Dlp';

interface Props {
  enabled: boolean;
}

const TONES = { blocked: 'danger', masked: 'warning', passed: 'neutral' } as const;

/**
 * Лента срабатываний: что и когда было заменено или отклонено.
 *
 * Самих значений здесь нет и не будет — только правило, метка и счётчик. Журнал
 * защиты данных, складывающий рядом сами данные, был бы главной дырой в этой
 * защите, поэтому сервер их и не пишет.
 */
export function DlpJournalCard({ enabled }: Props) {
  const { t } = useTranslation();
  const { data: entries = [] } = useDlpJournal(enabled);
  const clear = useClearDlpJournal();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="body" weight="medium">
            {t('dlp.journalTitle')}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="trash" size={16} />}
            onClick={() => clear.mutate()}
            disabled={entries.length === 0}
          >
            {t('dlp.journalClear')}
          </Button>
        </Stack>

        {entries.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {enabled ? t('dlp.journalEmpty') : t('dlp.journalOff')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-2xs)">
            {entries.map((entry, index) => (
              <Stack
                key={`${entry.at}-${index}`}
                direction="row"
                align="center"
                gap="var(--spacing-xs)"
                wrap
              >
                <Badge tone={TONES[entry.decision]}>{t(`dlp.decision.${entry.decision}`)}</Badge>
                <Typography variant="caption" color="subtle">
                  {new Date(entry.at).toLocaleTimeString()}
                </Typography>
                <Typography variant="caption" truncate>
                  {entry.path}
                </Typography>
                <Typography variant="caption" color="subtle">
                  {entry.hits.length > 0
                    ? entry.hits
                        .map((hit) => `${hit.placeholder || hit.ruleName}×${hit.count}`)
                        .join(', ')
                    : (entry.reason ?? '')}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
