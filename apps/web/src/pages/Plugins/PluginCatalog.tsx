import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { SearchField } from '@shared/ui/search-field';
import { VirtualList } from '@shared/ui/virtual-list';
import { CatalogRow } from './CatalogRow';
import type { PluginCatalogProps } from './PluginCatalog.types';

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
