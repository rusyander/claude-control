import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { useProviderRules } from '@entities/ProviderRules';
import { ProviderRulesPanel } from '../ProviderRulesPanel/ProviderRulesPanel';
import styles from './ProviderRulesPage.module.scss';
import { ruleFormat } from '../ruleFormat';

/**
 * Каталог правил CLI: раздел инструкций у Cursor/Continue и раздел правил у Qwen
 * (MAP 24, рядом с QWEN.md).
 * Заголовок называет вещи своими именами: это не редактор одного файла, а
 * менеджер каталога `.mdc`-правил CLI.
 */
export function ProviderRulesPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const provider = activeProvider(data);
  // Тот же запрос, что у панели ниже, — из кэша: формат решает подзаголовок.
  const rules = useProviderRules({});
  const format = rules.data?.format;
  const traits = ruleFormat(format);

  if (!provider) return <SkeletonList rows={5} />;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('providerRules.title', { provider: provider.name })}
        subtitle={t(traits.text('subtitle'), { provider: provider.name })}
        helpTopic="claudeMd"
      />
      <ProviderRulesPanel />
    </Stack>
  );
}
