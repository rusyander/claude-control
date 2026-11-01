import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { knownRefusal } from '../../model/refusalOf';
import type { RefusalNoteProps } from './RefusalNote.types';
import styles from './RefusalNote.module.scss';

/**
 * Отказ ядра словами человека: известный код — своей фразой (что случилось и что делать),
 * причина ядра — ниже как есть. Код в `data-scenario-refusal`: по нему проверка различает
 * «звено не подтверждено» и «версия занята», не читая перевод.
 */
export function RefusalNote({ refusal }: RefusalNoteProps) {
  const { t } = useTranslation();
  const code = knownRefusal(refusal.code);
  const details = refusal.problems.length > 0 ? refusal.problems : [refusal.reason];
  return (
    <div className={styles.note} role="alert" data-scenario-refusal={refusal.code}>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="semibold" color="danger" as="span">
          {t('coreScenario.refusal.title')}
        </Typography>
        {code && (
          <Typography variant="body-sm" as="span">
            {t(`coreScenario.refusal.${code}`, { next: refusal.next ?? '—' })}
          </Typography>
        )}
        {details
          .filter((line) => line.length > 0)
          .map((line) => (
            <Typography key={line} variant="caption" color="subtle" as="span">
              {line}
            </Typography>
          ))}
      </Stack>
    </div>
  );
}
