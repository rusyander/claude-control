import { useTranslation } from 'react-i18next';
import { sourceLabel } from '@shared/lib/location-label';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { LocationCardProps } from './LocationCard.types';

/**
 * Карточка расположения конфигурации. Показывает не только путь, но и как он
 * был найден: пользователю важно понимать, читает приложение стандартный
 * каталог или тот, что задали руками.
 */
export function LocationCard({ location }: LocationCardProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md" isRaised>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={24} />
          <Typography variant="body-sm" color="muted" as="span">
            {t('overview.configPath')}
          </Typography>
          <Badge tone={location.isValid ? 'success' : 'danger'} withDot>
            {sourceLabel(location, t)}
          </Badge>
        </Stack>

        <Typography variant="mono" as="span">
          {location.paths.root}
        </Typography>

        {location.missing.length > 0 && (
          <Typography variant="caption" color="warning" as="span">
            {t('overview.missingFiles')}: {location.missing.join(', ')}
          </Typography>
        )}

        {location.problem && (
          <Typography variant="caption" color="danger" as="span">
            {location.problem}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
