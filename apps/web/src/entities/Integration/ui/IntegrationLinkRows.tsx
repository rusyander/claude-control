import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { useSettings } from '@entities/AppConfig';
import { readIntegration } from '../model/settings';
import { linkRows } from '../model/links';
import type { IntegrationLinkRowsProps } from './IntegrationLinkRows.types';

/**
 * Привязка внешнего мира, показанная строками, — только чтение.
 *
 * Живёт в сущности, а не в фиче, намеренно: одну и ту же привязку показывают
 * окно тестов из чата, карточка проекта и раздел тестирования, а фичи друг
 * друга импортировать не могут. Правят привязку в одном месте — в модалке
 * привязки.
 *
 * Ссылка открывается в новой вкладке: панель — рабочее место, и уводить из неё
 * в чужой трекер нельзя, оттуда нет дороги назад к прогону.
 */
export function IntegrationLinkRows({ link, withEmpty = false }: IntegrationLinkRowsProps) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const rows = linkRows(link, readIntegration(settings, 'atlassian'));

  if (rows.length === 0) {
    if (!withEmpty) return null;
    return (
      <Typography variant="caption" color="subtle">
        {t('integrations.links.empty')}
      </Typography>
    );
  }

  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
      {rows.map((row) => (
        <Stack
          key={`${row.kind}:${row.text}`}
          direction="row"
          gap="var(--spacing-3xs)"
          align="center"
        >
          <Badge tone="neutral">{t(`integrations.links.kind.${row.kind}`)}</Badge>
          {row.url ? (
            <a href={row.url} target="_blank" rel="noreferrer" title={row.url}>
              <Typography variant="body-sm" as="span">
                {row.text}
              </Typography>
            </a>
          ) : (
            <Typography variant="body-sm" as="span" color="subtle">
              {row.text}
            </Typography>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
