import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderPluginsPanel } from './ProviderPluginsPanel';
import styles from './ProviderPluginsPage.module.scss';

/**
 * Раздел плагинов у провайдера, где они принадлежат САМОМУ CLI (OpenCode):
 * каталог файлов JS/TS плюс список npm-пакетов в конфиге. Раздел «Плагины»
 * панели (расширения панели) — это другая страница и другая модель.
 */
export function ProviderPluginsPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerPlugins.title', { provider: provider.name })}
        subtitle={t('providerPlugins.subtitle', { provider: provider.name })}
        helpTopic="plugins"
      />
      <ProviderPluginsPanel />
    </Stack>
  );
}
