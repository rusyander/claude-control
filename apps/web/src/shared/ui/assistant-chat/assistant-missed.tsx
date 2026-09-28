import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { groupMisses } from '@shared/lib/assistant-fields';
import type { AssistantMissedProps } from './assistant-missed.types';
import styles from './assistant-chat.module.scss';

/**
 * Что помощник предложил, но форма не приняла: несуществующие id, значение не
 * того вида, поле, которого нет, испорченная маска секрета. Называется под ответом — иначе человек думал
 * бы, что отмечено всё, о чём просил.
 */
export function AssistantMissed({ missed }: AssistantMissedProps) {
  const { t } = useTranslation();
  const { values, types, fields, secrets } = groupMisses(missed);
  const lines = [
    values.length > 0 && t('assistant.missedValues', { items: values.join('; ') }),
    types.length > 0 && t('assistant.missedTypes', { fields: types.join(', ') }),
    fields.length > 0 && t('assistant.missedFields', { fields: fields.join(', ') }),
    secrets.length > 0 && t('assistant.missedSecrets', { fields: secrets.join(', ') }),
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) return null;
  return (
    <div className={styles.missed} data-assistant-missed>
      {lines.map((line) => (
        <Typography key={line} variant="caption" color="warning">
          {line}
        </Typography>
      ))}
    </div>
  );
}
