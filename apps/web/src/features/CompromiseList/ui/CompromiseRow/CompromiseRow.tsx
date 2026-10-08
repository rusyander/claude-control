import type { CompromiseView } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography, CodeText } from '@shared/ui/typography';
import styles from '../CompromiseList.module.scss';
import { formatDate } from '../../../../shared/lib/formatDate';

export function CompromiseRow({ item, locale }: { item: CompromiseView; locale: string }) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="baseline" wrap>
          <Typography variant="body" weight="medium" as="h4">
            {t(`compromise.items.${item.id}.name`)}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('compromise.headline', {
              severity: t(`compromise.severity.${item.severity}`),
              date: formatDate(item.since, locale),
            })}
          </Typography>
          {/* «Ещё не в коде» — не украшение: обещать проверенным то, что не
              написано, ровно та ложь, ради которой заведён инвариант 13. */}
          {item.planned && (
            <Typography variant="caption" color="warning" className={styles.planned}>
              {t('compromise.planned')}
            </Typography>
          )}
        </Stack>

        <Typography variant="body-sm">
          <CodeText text={t(`compromise.items.${item.id}.how`)} />
        </Typography>
        <Typography variant="body-sm" color="muted">
          <CodeText text={t(`compromise.items.${item.id}.why`)} />
        </Typography>
        <Typography variant="caption" color="muted">
          {t('compromise.revisit')}:{' '}
          <CodeText text={t(`compromise.items.${item.id}.revisitWhen`)} />
        </Typography>
        {item.uiHidden && (
          <Typography variant="caption" color="muted">
            {t(`compromise.items.${item.id}.hiddenReason`)}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
