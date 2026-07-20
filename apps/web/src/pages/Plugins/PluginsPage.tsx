import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { Icon } from '@shared/ui/icon';
import {
  usePlugins,
  useAvailablePlugins,
  useInstallPlugin,
  useUninstallPlugin,
  useSetPluginEnabled,
  useUpdatePlugin,
  useAddMarketplace,
  useRemoveMarketplace,
} from '@entities/Plugin';
import { PluginCard } from './PluginCard';
import { PluginCatalog } from './PluginCatalog';
import styles from './PluginsPage.module.scss';

/** Плагины: что установлено, откуда и как этим управлять. */
export function PluginsPage() {
  const { t } = useTranslation();
  const [installId, setInstallId] = useState('');
  const [marketplaceSource, setMarketplaceSource] = useState('');
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);

  const { data, isLoading } = usePlugins();
  const catalog = useAvailablePlugins(isCatalogOpen);
  const install = useInstallPlugin();
  const uninstall = useUninstallPlugin();
  const setEnabled = useSetPluginEnabled();
  const update = useUpdatePlugin();
  const addMarketplace = useAddMarketplace();
  const removeMarketplace = useRemoveMarketplace();

  const isBusy =
    install.isPending || uninstall.isPending || setEnabled.isPending || update.isPending;

  // Вывод команды показываем как есть: это единственный источник правды
  // о том, что пошло не так при установке.
  const lastResult = install.data ?? uninstall.data ?? update.data ?? setEnabled.data ?? undefined;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('plugins.title')} subtitle={t('plugins.subtitle')} helpTopic="plugins" />

      <ExplainBox title={t('plugins.explainTitle')} text={t('plugins.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">
          {t('plugins.installed')} {data ? `· ${data.installed.length}` : ''}
        </Typography>

        {data?.installed.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            isBusy={isBusy}
            onToggle={(isEnabled) => setEnabled.mutate({ id: plugin.id, isEnabled })}
            onUninstall={() => uninstall.mutate(plugin.id)}
            onUpdate={() => update.mutate(plugin.id)}
          />
        ))}

        {data && data.installed.length === 0 && (
          <Typography color="subtle">{t('plugins.noPlugins')}</Typography>
        )}
      </Stack>

      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Typography variant="heading-sm">{t('plugins.catalog')}</Typography>
          {!isCatalogOpen && (
            <Button onClick={() => setIsCatalogOpen(true)}>{t('plugins.showCatalog')}</Button>
          )}
        </Stack>

        {isCatalogOpen ? (
          <PluginCatalog
            plugins={catalog.data ?? []}
            isLoading={catalog.isLoading}
            isBusy={isBusy}
            installingId={install.isPending ? install.variables : undefined}
            onInstall={(id) => install.mutate(id)}
          />
        ) : (
          <Typography variant="body-sm" color="subtle" className="prose">
            {t('plugins.catalogHint')}
          </Typography>
        )}
      </Stack>

      {/*
        Установка по идентификатору — путь для тех, кто уже знает имя плагина.
        Раньше эта форма занимала верх страницы и отодвигала вниз каталог, то
        есть единственный способ что-то найти. Теперь она свёрнута и стоит
        после каталога.
      */}
      <details className={styles.manualInstall}>
        <summary>{t('plugins.installTitle')}</summary>

        <Stack gap="var(--spacing-sm)" className={styles.manualInstallBody}>
          <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
            <div className={styles.installField}>
              <TextField
                label={t('plugins.installLabel')}
                value={installId}
                onChange={setInstallId}
                placeholder={t('plugins.installPlaceholder')}
                hint={t('plugins.installHint')}
                isMono
              />
            </div>
            <Button
              variant="primary"
              onClick={() => install.mutate(installId.trim())}
              disabled={!installId.trim() || isBusy}
              isLoading={install.isPending}
            >
              {t('plugins.install')}
            </Button>
          </Stack>

          {lastResult && !lastResult.ok && (
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" color="danger">
                {t('plugins.commandFailed')}
              </Typography>
              <Typography variant="mono" color="muted" className={styles.output}>
                {lastResult.output}
              </Typography>
            </Stack>
          )}

          {lastResult?.ok && (
            <Typography variant="caption" color="success">
              {t('common.needsRestart')}
            </Typography>
          )}
        </Stack>
      </details>

      <Stack gap="var(--spacing-sm)">
        <Typography variant="heading-sm">{t('plugins.marketplaces')}</Typography>

        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <TextField
            label={t('plugins.marketplaceSource')}
            value={marketplaceSource}
            onChange={setMarketplaceSource}
            placeholder="owner/repo, https://… или путь"
          />
          <Button
            variant="secondary"
            leftIcon={<Icon name="plus" size={20} />}
            isLoading={addMarketplace.isPending}
            disabled={!marketplaceSource.trim()}
            onClick={() =>
              addMarketplace.mutate(marketplaceSource.trim(), {
                onSuccess: () => setMarketplaceSource(''),
              })
            }
          >
            {t('plugins.marketplaceAdd')}
          </Button>
        </Stack>

        <Card padding="none">
          <Stack>
            {data?.marketplaces.map((marketplace) => (
              <Stack
                key={marketplace.name}
                direction="row"
                align="center"
                justify="between"
                gap="var(--spacing-sm)"
                className={styles.marketplaceRow}
              >
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap minWidth={0}>
                  <Typography variant="body-sm" weight="medium" as="span">
                    {marketplace.name}
                  </Typography>
                  <Badge tone="neutral">{marketplace.source}</Badge>
                </Stack>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="trash" size={20} />}
                  aria-label={`${t('common.delete')}: ${marketplace.name}`}
                  isLoading={removeMarketplace.isPending}
                  onClick={() => removeMarketplace.mutate(marketplace.name)}
                />
              </Stack>
            ))}
          </Stack>
        </Card>
      </Stack>
    </Stack>
  );
}
