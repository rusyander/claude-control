import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders } from '@entities/Provider';
import { activeProvider } from '@entities/Provider';
import { ProviderInstructionsPanel } from './ProviderInstructionsPanel';
import styles from './ProviderInstructionsPage.module.scss';

/**
 * Раздел инструкций у провайдера, где они устроены СПИСКОМ ССЫЛОК (Aider).
 * Заголовок называет вещи своими именами: это не редактор одного файла, а
 * управление списком подключаемых файлов в конфигурации CLI.
 */
export function ProviderInstructionsPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerInstructions.title', { provider: provider.name })}
        subtitle={t('providerInstructions.subtitle', { provider: provider.name })}
        helpTopic="claudeMd"
      />
      <ProviderInstructionsPanel />
    </Stack>
  );
}
