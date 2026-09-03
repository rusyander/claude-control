import { Stack } from '@shared/ui/stack';
import { ProviderSelectorCard } from './ProviderSelectorCard';
import { ProviderCheckCard } from './ProviderCheckCard';
import { ProviderKeysCard } from './ProviderKeysCard';
import { FormatCheckCard } from './FormatCheckCard';

/**
 * Раздел «Провайдеры»: каким CLI управляет панель, стоит ли он в системе, чем
 * он авторизуется и совпадают ли форматы его конфигов с опубликованными
 * схемами. Проверка и сверка форматов отвечают на один вопрос — можно ли
 * доверять записи в чужой конфиг, — поэтому живут рядом с выбором провайдера.
 */
export function ProvidersTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <ProviderSelectorCard />
      <ProviderCheckCard />
      <ProviderKeysCard />
      <FormatCheckCard />
    </Stack>
  );
}
