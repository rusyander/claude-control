import { useTranslation } from 'react-i18next';
import type { CoreRefusal } from '@entities/CoreTask';
import { EmptyState } from '@shared/ui/empty-state';

/**
 * Отказ прокладки по коду (07:18): ядра нет, ядро не подтвердило себя, ядро молчит. Один вид для
 * списка и ленты задачи — человек видит одну и ту же причину, откуда бы ни открыл раздел.
 */
export function CoreRefusalCard({ refusal }: { refusal: CoreRefusal }) {
  const { t } = useTranslation();
  return (
    <div data-core-refusal={refusal}>
      <EmptyState
        icon="warning"
        title={t(`coreTimeline.refusal.${refusal}.title`)}
        text={t(`coreTimeline.refusal.${refusal}.text`)}
      />
    </div>
  );
}
