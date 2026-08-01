import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { EnvTransferChecklistProps } from './EnvTransferChecklist.types';
import styles from './EnvTransferCard.module.scss';

/**
 * Чек-лист «что придётся ввести руками». Секретов в архиве нет по устройству,
 * поэтому единственное, что панель может дать взамен, — точный список: какой
 * файл, какие ключи. Пустой список тоже показываем: «секретов не нашлось» это
 * ответ, а не отсутствие информации.
 */
export function EnvTransferChecklist({ items }: EnvTransferChecklistProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="body-sm" weight="medium">
        {t('envTransfer.checklistTitle')}
      </Typography>
      <Typography variant="body-sm" color="subtle" className="prose">
        {t('envTransfer.checklistHint')}
      </Typography>

      {items.length === 0 ? (
        <Typography variant="body-sm" color="subtle">
          {t('envTransfer.checklistEmpty')}
        </Typography>
      ) : (
        <Stack gap="var(--spacing-3xs)" className={styles.checklist}>
          {items.map((item) => (
            <Stack key={`${item.reason}-${item.source}`} gap="0">
              <Typography variant="mono" className={styles.path}>
                {item.source}
              </Typography>
              <Typography variant="body-sm" color="subtle">
                {t(`envTransfer.checklistReason_${item.reason}`)}
                {item.keys.length > 0 && `: ${item.keys.join(', ')}`}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
