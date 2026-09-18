import { useTranslation } from 'react-i18next';
import type { PlatformSummarizedReport } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { formatDateTime } from '@shared/lib/format';
import { summarizedLinkOf } from './lib/summarizedView';

interface SummarizedCardProps {
  report: PlatformSummarizedReport | undefined;
  /** Id контура → его название: в строке человек читает имя, а не id. */
  platformTitles: Record<string, string>;
}

/**
 * Случаи, когда контур сам сжал историю (`context-managed`).
 *
 * Подпись в ленте стоит только у ответа, к которому случай привязан точно. Здесь
 * — все случаи, и у каждого сказано, подписан ли ответ: запрос мимо чатов
 * панели подписать негде, и без этой карточки о нём не узнал бы никто.
 */
export function SummarizedCard({ report, platformTitles }: SummarizedCardProps) {
  const { t, i18n } = useTranslation();
  const recent = report?.recent ?? [];

  return (
    <Card padding="md" data-contour-summarized>
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Typography variant="body" weight="medium" as="h2">
              {t('platform.summarizedTitle')}
            </Typography>
            <CompromiseMark id="context-managed" />
          </Stack>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.summarizedText')}
          </Typography>
        </Stack>

        {recent.length === 0 ? (
          <Typography variant="body-sm" color="muted">
            {t('platform.summarizedEmpty')}
          </Typography>
        ) : (
          <>
            {/* Строкой, а не прямым ребёнком колонки: иначе значок растягивается на всю ширину. */}
            <Stack direction="row">
              <Badge tone="warning">
                {t('platform.summarizedTotal', { total: report?.total ?? 0 })}
              </Badge>
            </Stack>
            <Stack
              as="ul"
              gap="var(--spacing-2xs)"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {recent.map((item, index) => (
                <Stack
                  as="li"
                  key={`${item.at}-${index}`}
                  direction="row"
                  align="center"
                  justify="between"
                  gap="var(--spacing-xs)"
                  wrap
                  data-contour-summarized-row={summarizedLinkOf(item.link)}
                >
                  <Typography variant="body-sm" as="span">
                    {platformTitles[item.platformId] ?? item.platformId} ·{' '}
                    {formatDateTime(item.at, i18n.language)}
                  </Typography>
                  <Typography variant="caption" color="muted" as="span">
                    {t(`platform.summarizedLink.${summarizedLinkOf(item.link)}`)}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </>
        )}

        <Typography variant="caption" color="muted">
          {t('platform.summarizedKept')}
        </Typography>
      </Stack>
    </Card>
  );
}
