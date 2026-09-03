import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProviders, activeProvider } from '@entities/Provider';
import { useProviderHooks } from '@entities/ProviderHooks';
import { ProviderHooksPanel } from './ProviderHooksPanel';

/**
 * Раздел хуков у провайдера, где они устроены КЛЮЧОМ КОНФИГА. Заголовок называет
 * вещи своими именами и следует форме файла (`shape` с сервера): у OpenCode это
 * `experimental.hook` в opencode.json, у Qwen Code — ключ `hooks` в settings.json
 * со списком правил «событие → матчер → команда».
 */
export function ProviderHooksPage() {
  const { t } = useTranslation();
  const { data } = useProviders();
  const { data: hooks } = useProviderHooks();
  const provider = activeProvider(data);

  if (!provider) return <SkeletonList rows={5} />;

  const subtitleKey =
    hooks?.shape === 'event-rules' ? 'providerHooks.subtitleRules' : 'providerHooks.subtitle';

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerHooks.title', { provider: provider.name })}
        subtitle={t(subtitleKey, { provider: provider.name })}
        helpTopic="hooks"
      />
      <ProviderHooksPanel />
    </Stack>
  );
}
