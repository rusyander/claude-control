import { Stack } from '@shared/ui/stack';
import { PromptsCard } from './PromptsCard';

/**
 * Раздел «Промпты»: тексты, которыми панель разговаривает с моделью не от имени
 * человека. Одна карточка — но своя вкладка, а не пристройка к «Моделям»:
 * промпт правят страницей текста, и место для этого нужно всё.
 */
export function PromptsTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <PromptsCard />
    </Stack>
  );
}
