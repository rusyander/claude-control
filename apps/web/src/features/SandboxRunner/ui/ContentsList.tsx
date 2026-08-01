import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import type { ContentsListProps } from './ContentsList.types';

export function ContentsList({ description }: ContentsListProps) {
  const { t } = useTranslation();

  const groups: [string, string[]][] = [
    [t('nav.rules'), description.rules],
    [t('nav.skills'), description.skills],
    [t('nav.hooks'), description.hooks],
    [t('nav.scripts'), description.scripts],
    [t('nav.mcp'), description.mcpServers],
  ];

  const filled = groups.filter(([, items]) => items.length > 0);

  if (filled.length === 0) {
    return (
      <Typography variant="caption" color="subtle">
        {t('sandbox.empty')}
      </Typography>
    );
  }

  return (
    <Stack gap="var(--spacing-2xs)">
      {filled.map(([label, items]) => (
        <Stack key={label} gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {label}
          </Typography>
          <Stack direction="row" gap="var(--spacing-3xs)" wrap>
            {items.map((item) => (
              <Badge key={item} tone="info">
                {item}
              </Badge>
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
