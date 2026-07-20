import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { SearchField } from '@shared/ui/search-field';
import { VirtualList } from '@shared/ui/virtual-list';
import { TruncatedText } from '@shared/ui/truncated-text';
import type { CatalogRowProps, PluginCatalogProps } from './PluginCatalog.types';
import styles from './PluginCatalog.module.scss';

/**
 * Каталог маркетплейсов: несколько сотен плагинов, поэтому список
 * виртуализирован, а искать приходится и по имени, и по описанию —
 * по названию плагина не всегда понятно, что он делает.
 */
export function PluginCatalog({
  plugins,
  isLoading,
  isBusy,
  installingId,
  onInstall,
}: PluginCatalogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return plugins;

    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(needle) ||
        plugin.marketplace.toLowerCase().includes(needle) ||
        (plugin.description ?? '').toLowerCase().includes(needle),
    );
  }, [plugins, query]);

  if (isLoading) {
    return <Typography color="muted">{t('plugins.catalogLoading')}</Typography>;
  }

  return (
    <Stack gap="var(--spacing-sm)">
      <SearchField
        label={t('plugins.searchCatalog')}
        value={query}
        onChange={setQuery}
        placeholder={t('plugins.searchCatalogPlaceholder')}
      />

      <Typography variant="caption" color="subtle">
        {t('plugins.catalogCount', { found: found.length, total: plugins.length })}
      </Typography>

      <Card padding="none">
        <VirtualList
          items={found}
          rowHeight={84}
          height={620}
          getKey={(plugin) => plugin.id}
          renderRow={(plugin) => (
            <CatalogRow
              plugin={plugin}
              isBusy={isBusy}
              isInstalling={installingId === plugin.id}
              onInstall={() => onInstall(plugin.id)}
            />
          )}
        />
      </Card>

      {found.length === 0 && <Typography color="subtle">{t('common.empty')}</Typography>}
    </Stack>
  );
}

function CatalogRow({ plugin, isBusy, isInstalling, onInstall }: CatalogRowProps) {
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

/** Тысячи сокращаем: точное число установок роли не играет. */
function formatCount(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}
