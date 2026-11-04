import { Stack } from '@shared/ui/stack';
import { CoreEconomyCard } from '../CoreEconomyCard/CoreEconomyCard';
import { SievesCard } from '../SievesCard/SievesCard';

/**
 * Раздел «Группы»: экономия шагов задачи и сита перед MR. Правила разделения по умолчанию, их
 * проектная правка и журнал проверок ушли вместе с прежним исполнителем групп (этап 10, F1);
 * карточки «Экономия групп разделения» и «Сторож групп разделения» — вместе с его рычагами и
 * сторожем (этап 10, G15). Рычаги экономии хранит ядро (раздел `economy` его настройки), сита —
 * сервер.
 */
export function GroupsTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <CoreEconomyCard />
      <SievesCard />
    </Stack>
  );
}
