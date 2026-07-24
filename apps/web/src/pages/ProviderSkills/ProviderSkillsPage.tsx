import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderSkillsPanel } from './ProviderSkillsPanel';
import styles from './ProviderSkillsPage.module.scss';

/**
 * Раздел скиллов у провайдера, где они принадлежат САМОМУ CLI (OpenCode):
 * каталог папок со `SKILL.md`. Раздел скиллов Claude — другая страница и другая
 * модель.
 */
export function ProviderSkillsPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerSkills.title', { provider: provider.name })}
        subtitle={t('providerSkills.subtitle', { provider: provider.name })}
        helpTopic="skills"
      />
      <ProviderSkillsPanel />
    </Stack>
  );
}
