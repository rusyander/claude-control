import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';

interface AccountInfo {
  email?: string;
  displayName?: string;
  organization?: string;
  billingType?: string;
  isSubscription: boolean;
  hasExtraUsage?: boolean;
}

/**
 * Чей аккаунт используется. Данные берутся из конфигурации Claude Code —
 * той же, по которой он авторизуется, поэтому это именно та подписка,
 * под которой идёт работа.
 */
export function AccountCard() {
  const { t } = useTranslation();

  const { data } = useQuery({
    queryKey: ['account'],
    queryFn: async () => {
      const { data: account } = await apiClient.get<AccountInfo>('/account');
      return account;
    },
  });

  if (!data?.email) return null;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="span">
            {t('settings.account')}
          </Typography>
          <Badge tone={data.isSubscription ? 'success' : 'neutral'} withDot>
            {data.isSubscription ? t('settings.subscription') : (data.billingType ?? '—')}
          </Badge>
        </Stack>

        <Stack gap="var(--spacing-3xs)">
          {data.displayName && (
            <Typography variant="body-sm" as="span">
              {data.displayName}
            </Typography>
          )}
          <Typography variant="mono" color="muted" as="span">
            {data.email}
          </Typography>
          {data.organization && (
            <Typography variant="caption" color="subtle" as="span">
              {data.organization}
            </Typography>
          )}
        </Stack>

        <Typography variant="caption" color="subtle">
          {t('settings.limitsNote')}
        </Typography>
      </Stack>
    </Card>
  );
}
