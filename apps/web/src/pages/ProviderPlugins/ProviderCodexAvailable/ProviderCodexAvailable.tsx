import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useInstallProviderExtension } from '@entities/ProviderPlugins';
import type { ProviderCodexAvailableProps } from './ProviderCodexAvailable.types';
import styles from './ProviderCodexAvailable.module.scss';

/**
 * Плагины подключённых рынков, ещё не поставленные (`codex plugin list
 * --available`). «Поставить» уходит как `codex plugin add имя@рынок`;
 * предупреждение о доверии стоит над списком, а не в справке: плагин запускает
 * свой код, MCP-серверы и хуки.
 */
export function ProviderCodexAvailable({ plugins }: ProviderCodexAvailableProps) {
  const { t } = useTranslation();
  const install = useInstallProviderExtension();

  return (
    <Card padding="sm">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          {t('providerPlugins.codex.availableTitle')}
        </Typography>
        <Stack direction="row" align="center" gap="var(--spacing-xs)">
          <Icon name="warning" size={18} />
          <Typography variant="body-sm" color="warning">
            {t('providerPlugins.codex.trust')}
          </Typography>
        </Stack>

        {plugins.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('providerPlugins.codex.availableEmpty')}
          </Typography>
        ) : (
          <Stack gap="var(--spacing-xs)">
            {plugins.map((plugin) => (
              <Stack key={plugin.id} gap="var(--spacing-2xs)">
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium">
                    {plugin.displayName ?? plugin.name ?? plugin.id}
                  </Typography>
                  {plugin.version && <Badge tone="neutral">{plugin.version}</Badge>}
                  {plugin.marketplace && (
                    <Badge tone="neutral">
                      {t('providerPlugins.codex.marketplace', { name: plugin.marketplace })}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    className={styles.rowActions}
                    disabled={install.isPending}
                    isLoading={install.isPending && install.variables === plugin.id}
                    onClick={() => install.mutate(plugin.id)}
                    aria-label={`${t('providerPlugins.codex.install')}: ${plugin.id}`}
                  >
                    {t('providerPlugins.codex.install')}
                  </Button>
                </Stack>
                {plugin.description && (
                  <Typography variant="body-sm" color="subtle">
                    {plugin.description}
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
