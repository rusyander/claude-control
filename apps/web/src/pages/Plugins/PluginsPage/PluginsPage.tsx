import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { serverFieldList } from '@shared/config/i18n';
import type { Plugin } from '@agentdeck/contracts';
import { useEntityUrl } from '@shared/hooks/use-entity-url';
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
import { PageTabs, PageTabPanel } from '@shared/ui/page-tabs';
import { usePageTab } from '@shared/hooks/use-page-tab';
import { DeleteButton } from '@features/EntityDelete';
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
import { PluginCard } from '../PluginCard/PluginCard';
import { PluginCatalog } from '../PluginCatalog/PluginCatalog';
import { PluginScaffold } from '../PluginScaffold/PluginScaffold';
import { PLUGINS_TABS, PLUGINS_TAB_ICONS, type PluginsTabId } from '../model/tabs';
import styles from './PluginsPage.module.scss';
import { CommandOutcome } from '../CommandOutcome/CommandOutcome';
import { lastResult } from '../model/lastResult';

/** Плагины: что установлено, откуда и как этим управлять. */
export function PluginsPage() {
  const { t } = useTranslation();
  const [installId, setInstallId] = useState('');
  const [marketplaceSource, setMarketplaceSource] = useState('');
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  // Плагин, на который привела ссылка /plugins?id=… (поиск): у карточек нет
  // формы, поэтому «открыть» здесь — подвести к карточке и подсветить её.
  const [highlightedId, setHighlightedId] = useState<string | undefined>(undefined);

  const { active: activeTab, select: selectTab } = usePageTab('plugins', PLUGINS_TABS);

  const { data, isLoading } = usePlugins();
  // Ссылка ведёт на УСТАНОВЛЕННЫЙ плагин — значит, на его вкладку, с какой бы
  // вкладки человек ни пришёл в раздел в прошлый раз.
  useEntityUrl<Plugin>({
    items: data?.installed,
    getId: (plugin) => plugin.id,
    onOpen: (plugin) => {
      setHighlightedId(plugin.id);
      if (activeTab !== 'installed') selectTab('installed');
    },
  });
  useEffect(() => {
    if (!highlightedId || activeTab !== 'installed') return;
    document
      .getElementById(`plugin-${highlightedId}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightedId, activeTab]);
  const catalog = useAvailablePlugins(isCatalogOpen);
  const install = useInstallPlugin();
  const uninstall = useUninstallPlugin();
  const setEnabled = useSetPluginEnabled();
  const update = useUpdatePlugin();
  const addMarketplace = useAddMarketplace();
  const removeMarketplace = useRemoveMarketplace();

  const isBusy =
    install.isPending || uninstall.isPending || setEnabled.isPending || update.isPending;

  // Итог команды — на той вкладке, где её дали: тумблер, обновление и удаление
  // живут на «Установленных», установка по имени — в форме на «Каталоге».
  const installedResult = lastResult([uninstall, update, setEnabled]);

  const marketplaceDeleteText = (name: string): string => {
    const names = (data?.installed ?? [])
      .filter((plugin) => plugin.marketplace === name)
      .map((plugin) => plugin.name);
    return names.length > 0
      ? t('plugins.deleteMarketplaceWithPlugins', { names: names.join(', ') })
      : t('plugins.deleteMarketplace');
  };

  const tabs = PLUGINS_TABS.map((id) => {
    const counts: Partial<Record<PluginsTabId, number | undefined>> = {
      installed: data?.installed.length,
      marketplaces: data?.marketplaces.length,
    };
    const count = counts[id];
    return {
      id,
      label: t(`pageTabs.plugins.tab.${id}`),
      icon: PLUGINS_TAB_ICONS[id],
      ...(count === undefined ? {} : { count }),
    };
  });

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('plugins.title')} subtitle={t('plugins.subtitle')} helpTopic="plugins" />

      <ExplainBox title={t('plugins.explainTitle')} text={t('plugins.explain')} />

      {/* CLI не ответил — список неполный, и человек должен видеть причину, а не ноль. */}
      {data &&
        serverFieldList(data, 'notes').map((note) => (
          <Typography key={note} variant="body-sm" color="warning">
            {note}
          </Typography>
        ))}

      <PageTabs
        page="plugins"
        label={t('pageTabs.plugins.tabsLabel')}
        tabs={tabs}
        active={activeTab}
        onSelect={selectTab}
      />

      <PageTabPanel page="plugins" tab={activeTab} hint={t(`pageTabs.plugins.hint.${activeTab}`)}>
        {activeTab === 'installed' && (
          <Stack gap="var(--spacing-sm)">
            {isLoading && <SkeletonList rows={5} />}

            {data?.installed.map((plugin) => (
              <div
                key={plugin.id}
                id={`plugin-${plugin.id}`}
                data-highlighted={plugin.id === highlightedId ? 'true' : undefined}
                className={plugin.id === highlightedId ? styles.highlighted : undefined}
              >
                <PluginCard
                  plugin={plugin}
                  isBusy={isBusy}
                  onToggle={(isEnabled) => setEnabled.mutate({ id: plugin.id, isEnabled })}
                  onUninstall={() => uninstall.mutate(plugin.id)}
                  onUpdate={() => update.mutate(plugin.id)}
                />
              </div>
            ))}

            {data && data.installed.length === 0 && (
              <Typography color="subtle">{t('plugins.noPlugins')}</Typography>
            )}

            <CommandOutcome result={installedResult} />
          </Stack>
        )}

        {activeTab === 'catalog' && (
          <>
            {/*
              Каталог не грузится сам и на этой вкладке: загрузка обновляет
              репозитории маркетплейсов и идёт до минуты, а на вкладку попадают и
              стрелкой с клавиатуры, проходя мимо.
            */}
            {isCatalogOpen ? (
              <PluginCatalog
                plugins={catalog.data ?? []}
                isLoading={catalog.isLoading}
                isBusy={isBusy}
                installingId={install.isPending ? install.variables : undefined}
                onInstall={(id) => install.mutate(id)}
              />
            ) : (
              <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
                <Button onClick={() => setIsCatalogOpen(true)}>{t('plugins.showCatalog')}</Button>
                <Typography variant="body-sm" color="subtle" className="prose">
                  {t('plugins.catalogHint')}
                </Typography>
              </Stack>
            )}

            {/*
              Установка по идентификатору — путь для тех, кто уже знает имя
              плагина. Свёрнута и стоит после каталога: единственный способ
              что-то найти — каталог, и форма не должна его отодвигать.
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

                <CommandOutcome result={install.data} />
              </Stack>
            </details>
          </>
        )}

        {activeTab === 'marketplaces' && (
          <Stack gap="var(--spacing-sm)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              {/* Тот же приём, что у поля установки: без пола поле делит строку с
                  кнопкой и ужимается до 185px, а от подсказки остаётся «owner/repo,
                  https://… или». Кнопка при нехватке места переносится вниз. */}
              <div className={styles.installField}>
                <TextField
                  label={t('plugins.marketplaceSource')}
                  value={marketplaceSource}
                  onChange={setMarketplaceSource}
                  placeholder={t('plugins.marketplaceSourceHint')}
                />
              </div>
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

            {isLoading && <SkeletonList rows={2} />}

            {data && data.marketplaces.length === 0 && (
              <Typography color="subtle">{t('plugins.noMarketplaces')}</Typography>
            )}

            {data && data.marketplaces.length > 0 && (
              <Card padding="none">
                <Stack>
                  {data.marketplaces.map((marketplace) => (
                    <Stack
                      key={marketplace.name}
                      direction="row"
                      align="center"
                      justify="between"
                      gap="var(--spacing-sm)"
                      className={styles.marketplaceRow}
                    >
                      <Stack
                        direction="row"
                        align="center"
                        gap="var(--spacing-xs)"
                        wrap
                        minWidth={0}
                      >
                        <Typography variant="body-sm" weight="medium" as="span">
                          {marketplace.name}
                        </Typography>
                        <Badge tone="neutral">{marketplace.source}</Badge>
                      </Stack>
                      {/*
                        Удаление источника — не косметика: Claude Code вместе с ним
                        убирает из установленных все его плагины, молча. Поэтому здесь
                        тот же диалог с вводом имени, что у плагина, и в нём перечислено,
                        что именно пропадёт.
                      */}
                      <DeleteButton
                        entityName={marketplace.name}
                        description={marketplaceDeleteText(marketplace.name)}
                        onDelete={() => removeMarketplace.mutate(marketplace.name)}
                        isPending={removeMarketplace.isPending}
                      />
                    </Stack>
                  ))}
                </Stack>
              </Card>
            )}
          </Stack>
        )}

        {/* Свой плагин с нуля: каркас по формату Claude Code в выбранной папке. */}
        {activeTab === 'scaffold' && <PluginScaffold />}
      </PageTabPanel>
    </Stack>
  );
}
