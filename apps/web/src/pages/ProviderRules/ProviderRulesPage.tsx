import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderRulesPanel } from './ProviderRulesPanel';
import styles from './ProviderRulesPage.module.scss';

/**
 * Раздел инструкций у провайдера, где они устроены КАТАЛОГОМ ПРАВИЛ (Cursor).
 * Заголовок называет вещи своими именами: это не редактор одного файла, а
 * менеджер каталога `.mdc`-правил CLI.
 */
export function ProviderRulesPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerRules.title', { provider: provider.name })}
        subtitle={t('providerRules.subtitle', { provider: provider.name })}
        helpTopic="claudeMd"
      />
      <ProviderRulesPanel />
    </Stack>
  );
}
