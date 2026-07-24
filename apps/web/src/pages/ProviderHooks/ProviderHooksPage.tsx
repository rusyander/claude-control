import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderHooksPanel } from './ProviderHooksPanel';

/**
 * Раздел хуков у провайдера, где они устроены КЛЮЧОМ КОНФИГА (OpenCode).
 * Заголовок называет вещи своими именами: это не события Claude, а
 * `experimental.hook` чужого CLI — и раздел у самого CLI экспериментальный.
 */
export function ProviderHooksPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerHooks.title', { provider: provider.name })}
        subtitle={t('providerHooks.subtitle', { provider: provider.name })}
        helpTopic="hooks"
      />
      <ProviderHooksPanel />
    </Stack>
  );
}
