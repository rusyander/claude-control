import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { TruncatedText } from '@shared/ui/truncated-text';
import { formatCount } from './CatalogRow.lib';
import type { CatalogRowProps } from './CatalogRow.types';
import styles from './PluginCatalog.module.scss';

/** Строка каталога: плагин, откуда он и кнопка установки. */
export function CatalogRow({ plugin, isBusy, isInstalling, onInstall }: CatalogRowProps) {
  const { t } = useTranslation();

  return (
    <Stack
      direction="row"
      align="start"
      justify="between"
      gap="var(--spacing-md)"
      className={styles.row}
    >
      <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="body-sm" weight="medium" as="span">
            {plugin.name}
          </Typography>
          <Badge tone="neutral">{plugin.marketplace}</Badge>
          {plugin.installCount !== undefined && (
            <Typography variant="caption" color="subtle" as="span">
              {formatCount(plugin.installCount)} {t('plugins.installs')}
            </Typography>
          )}
        </Stack>

        {plugin.description && (
          <TruncatedText text={plugin.description} variant="caption" color="muted" />
        )}
      </Stack>

      <Button size="sm" onClick={onInstall} disabled={isBusy} isLoading={isInstalling}>
        {t('plugins.install')}
      </Button>
    </Stack>
  );
}
