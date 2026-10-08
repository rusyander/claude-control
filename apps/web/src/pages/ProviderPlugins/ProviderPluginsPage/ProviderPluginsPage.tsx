import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { useProviderPlugins } from '@entities/ProviderPlugins';
import { ProviderPluginsPanel } from '../ProviderPluginsPanel/ProviderPluginsPanel';
import styles from './ProviderPluginsPage.module.scss';
import { SUBTITLE_BY_FORMAT } from './ProviderPluginsPage.constants';

/**
 * Раздел плагинов у провайдера, где они принадлежат САМОМУ CLI: у OpenCode —
 * каталог файлов JS/TS плюс список npm-пакетов в конфиге, у Kimi — установленные
 * плагины (показ), у Qwen — расширения (команды `qwen extensions`), у Codex —
 * плагины с рынков (команды `codex plugin`). Раздел «Плагины»
 * панели (расширения панели) — это другая страница и другая модель.
 */
export function ProviderPluginsPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);
  // Тот же запрос, что у панели (кэш общий): подзаголовок называет модель раздела.
  const { data: plugins } = useProviderPlugins();
  const subtitleKey = plugins ? SUBTITLE_BY_FORMAT[plugins.format] : 'providerPlugins.subtitle';

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerPlugins.title', { provider: provider.name })}
        subtitle={t(subtitleKey, { provider: provider.name })}
        helpTopic="plugins"
      />
      <ProviderPluginsPanel />
    </Stack>
  );
}
