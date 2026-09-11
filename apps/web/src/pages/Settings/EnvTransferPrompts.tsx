import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import type { BadgeTone } from '@shared/ui/badge';
import type { EnvTransferPromptsProps } from './EnvTransferPrompts.types';
import styles from './EnvTransferCard.module.scss';

/**
 * Правки промптов из архива — отдельной секцией плана, по той же причине, что и
 * контуры: у них нет ни места, ни пути на диске провайдера.
 *
 * Встроенных текстов в архиве нет вовсе, поэтому разворот не может подменить
 * встроенный промпт этой панели — только положить рядом чужую правку. Промпт,
 * которого в этой панели нет (архив собран новее), показан отдельной строкой и
 * отметить его нельзя: записать такую правку было бы некуда.
 *
 * Умолчание то же, что у файлов и контуров: отмечено только новое.
 */
const TONE: Record<'new' | 'same' | 'differs', BadgeTone> = {
  new: 'success',
  same: 'neutral',
  differs: 'warning',
};

export function EnvTransferPrompts({ plan, selected, onToggle }: EnvTransferPromptsProps) {
  const { t } = useTranslation();

  if (plan.problem) {
    return (
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium">
          {t('envTransfer.promptsTitle')}
        </Typography>
        <Typography variant="body-sm" color="danger">
          {plan.problem}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="body-sm" weight="medium">
        {t('envTransfer.promptsTitle')}
      </Typography>
      <Typography variant="body-sm" color="subtle" className="prose">
        {t('envTransfer.promptsHint')}
      </Typography>

      <div className={styles.entries}>
        {plan.entries.map((entry) => (
          <label key={entry.id} className={styles.entry}>
            <input
              type="checkbox"
              checked={selected.has(entry.id)}
              disabled={entry.unknown}
              onChange={() => onToggle(entry.id)}
            />
            <Stack gap="0" className={styles.entryName}>
              <Typography variant="body-sm" as="span" truncate>
                {entry.unknown ? entry.id : t(`settings.prompts.name.${entry.id}`)}
              </Typography>
              <Typography variant="body-sm" color="subtle">
                {entry.unknown
                  ? t('envTransfer.promptUnknown')
                  : t('envTransfer.promptBytes', { bytes: entry.bytes })}
              </Typography>
            </Stack>
            <Badge tone={entry.unknown ? 'danger' : TONE[entry.status]}>
              {t(`envTransfer.status_${entry.status}`)}
            </Badge>
          </label>
        ))}
      </div>
    </Stack>
  );
}
